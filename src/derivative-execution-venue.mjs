import { checked, freeze, hash, integer, json, nat, requireThat } from './core.mjs';
import { derivativeConfig, derivativeDataWindow } from './derivative-data.mjs';
import { verifyBendRuntime } from './bend-runtime.mjs';
import { ReplayRecording } from './recording.mjs';

const abs = n => n < 0n ? -n : n;
const sign = n => n < 0n ? -1n : 1n;
const min = (a, b) => a < b ? a : b;
const ceil = (n, d) => (n + d - 1n) / d;
// Conservative settlement rounding: gains down, losses away from zero.
const floor = (n, d) => n < 0n ? -ceil(-n, d) : n / d;
const copy = value => JSON.parse(json(value));
/** Single-instrument collateral account; FIFO positions; linear or inverse payoff.
 * The existing runner supplies only target lots and decision time at this seam.
 */
export class DerivativeExecutionVenue {
  #runtime; #data; #cursor = 0; #time = null; #mark = null; #quote = null;
  #cash; #positions = []; #orders; #working = null; #fills; #postings;
  #valuations; #errors = []; #finished = false; #halted = false; #settled = false;
  #realized = 0n; #fees = 0n; #funding = 0n; #liquidations = 0;
  #startTime; #endTime;
  #recording; #orderCount = 0; #peak; #drawdown = 0n; #staleHistory = false; #traceHash;
  constructor(options) {
    requireThat(options && Object.keys(options).every(key => ['id', 'config', 'data', 'window', 'auditDirectory'].includes(key)), 'VENUE_OPTION', 'Derivative venue options are id, config, data, window and auditDirectory');
    const { id, config, data } = options;
    requireThat(typeof id === 'string' && id.length > 0, 'EXECUTION_VENUE', 'Venue identity required');
    this.config = derivativeConfig(config);
    const selected = derivativeDataWindow(data, this.config, options.window);
    this.#data = selected.data; this.#cursor = selected.cursor;
    this.#startTime = selected.startTime; this.#endTime = selected.endTime;
    if (selected.mark) this.#mark = { price: BigInt(selected.mark.price), time: BigInt(selected.mark.time) };
    if (selected.quote) this.#quote = { ...selected.quote, time: BigInt(selected.quote.time) };
    if (selected.settlement) {
      this.#settled = true;
      if (!selected.mark || BigInt(selected.settlement.time) >= BigInt(selected.mark.time)) this.#mark = { price: BigInt(selected.settlement.price), time: BigInt(selected.settlement.time) };
    }
    this.#runtime = verifyBendRuntime();
    this.#cash = { $: 'DerivativeCash', credits: BigInt(config.initialCash), debits: 0n };
    this.#recording = new ReplayRecording(options.auditDirectory);
    this.#orders = this.#recording.map('orders'); this.#fills = this.#recording.series('fills');
    this.#postings = this.#recording.series('postings'); this.#valuations = this.#recording.series('valuations');
    this.#peak = BigInt(config.initialCash);
    this.instrument = this.config.instrument;
    this.manifest = freeze({ id, model: 'derivative-fifo-v1', instrument: this.instrument, contract: this.config.contract,
      configHash: hash(this.config), datasetHash: selected.datasetHash, window: { startTime: this.#startTime, endTime: this.#endTime }, margin: 'single-instrument-cross-collateral',
      rounding: 'P&L floor per FIFO slice; fees/margin ceil; funding transfers away from zero',
      liquidation: 'full close at adverse slipped mark, independent of quote liquidity; halt after liquidation' });
    Object.freeze(this);
  }
  get #quantity() { return this.#positions.reduce((n, p) => n + p.quantity, 0n); }
  get #wallet() { return this.#cash.credits - this.#cash.debits; }
  #notional(lots, price) {
    const c = this.config.contract, value = abs(lots) * BigInt(c.contractValue);
    return c.payoff === 'linear' ? [value * price, 1n] : [value * BigInt(c.settlementScale), price];
  }
  #charge(lots, price, rate, denominator = 10000n) {
    const [n, d] = this.#notional(lots, price);
    return checked(ceil(n * rate, d * denominator), 'settlement charge');
  }
  #pnl(quantity, entry, exit) {
    const c = this.config.contract, n = quantity * BigInt(c.contractValue) * (exit - entry);
    const result = c.payoff === 'linear' ? n : floor(n * BigInt(c.settlementScale), entry * exit);
    checked(abs(result), 'P&L magnitude');
    return result;
  }
  #unrealized(positions = this.#positions, mark = this.#mark?.price) {
    return mark === undefined ? 0n : positions.reduce((sum, p) => sum + this.#pnl(p.quantity, p.price, mark), 0n);
  }
  #fresh(item, maxAge, time = this.#time) { return item !== null && time - item.time <= BigInt(maxAge); }
  #post(amount, type, eventId, time) {
    const credit = amount > 0n ? amount : 0n, debit = amount < 0n ? -amount : 0n;
    const expected = { credits: checked(this.#cash.credits + credit, 'cumulative credits'), debits: checked(this.#cash.debits + debit, 'cumulative debits') };
    const next = this.#runtime.engine.derivative_post(this.#cash, credit, debit);
    requireThat(next.credits === expected.credits && next.debits === expected.debits, 'RECONCILIATION', 'Bend derivative posting differs from independent reconciliation');
    this.#cash = next;
    this.#postings.push({ type, eventId, time, amount, cash: this.#wallet });
  }
  #preview(delta, price) {
    const positions = this.#positions.map(p => ({ ...p }));
    let remaining = delta, realized = 0n;
    while (remaining !== 0n && positions.length && sign(remaining) !== sign(positions[0].quantity)) {
      const p = positions[0], closed = min(abs(remaining), abs(p.quantity));
      realized += this.#pnl(sign(p.quantity) * closed, p.price, price);
      remaining += sign(p.quantity) * closed; p.quantity -= sign(p.quantity) * closed;
      if (p.quantity === 0n) positions.shift();
    }
    if (remaining !== 0n) positions.push({ quantity: remaining, price });
    return { positions, realized };
  }
  #canFill(delta, price) {
    const quantity = this.#quantity, next = quantity + delta;
    if (abs(next) > BigInt(this.config.maxPositionLots)) return false;
    // Reductions are always allowed, including when collateral is below initial margin.
    if (quantity !== 0n && sign(delta) !== sign(quantity) && abs(delta) <= abs(quantity)) return true;
    const preview = this.#preview(delta, price);
    const equity = this.#wallet + preview.realized - this.#charge(delta, price, BigInt(this.config.feeBps)) + this.#unrealized(preview.positions);
    return equity >= this.#charge(next, this.#mark.price, BigInt(this.config.initialMarginBps));
  }
  #fill(delta, price, event, reason, orderId = null) {
    const preview = this.#preview(delta, price);
    const feeRate = BigInt(this.config.feeBps) + (reason === 'liquidation' ? BigInt(this.config.liquidationFeeBps) : 0n);
    const fee = this.#charge(delta, price, feeRate);
    // Check the complete fill before either posting can commit.
    checked(this.#cash.credits + (preview.realized > 0n ? preview.realized : 0n), 'fill credits');
    checked(this.#cash.debits + (preview.realized < 0n ? -preview.realized : 0n) + fee, 'fill debits');
    this.#post(preview.realized, 'realized-pnl', event.id, event.time);
    this.#post(-fee, reason === 'liquidation' ? 'liquidation-fee' : 'fee', event.id, event.time);
    this.#positions = preview.positions; this.#realized += preview.realized; this.#fees += fee;
    this.#fills.push({ id: `${event.id}/${orderId ?? reason}`, eventId: event.id, orderId, time: event.time,
      side: delta > 0n ? 'buy' : 'sell', quantity: abs(delta), price, fee, realizedPnl: preview.realized, reason });
  }
  #cancel(reason) {
    if (this.#working === null) return;
    const record = this.#working, next = this.#runtime.engine.cancel(record.order);
    record.order = next; record.status = reason; this.#orders.set(record.order.id,record); this.#working = null;
  }
  #advanceCancel(time) {
    if (this.#working === null) return;
    const record = this.#working;
    record.order = this.#runtime.engine.advance_order(record.order, time);
    if (record.order.remaining === 0n) { record.status = 'cancelled'; this.#working = null; }
    this.#orders.set(record.order.id,record);
  }
  #liquidate(event) {
    const quantity = this.#quantity;
    if (quantity === 0n || !this.#mark) return;
    const equity = this.#wallet + this.#unrealized();
    const maintenance = this.#charge(quantity, this.#mark.price, BigInt(this.config.maintenanceMarginBps));
    if (equity > maintenance) return;
    this.#cancel('cancelled-liquidation');
    const bps = BigInt(this.config.slippageBps), tick = BigInt(this.instrument.priceTick);
    const raw = this.#mark.price * (quantity > 0n ? 10000n - bps : 10000n + bps);
    const price = quantity > 0n ? (raw / (10000n * tick)) * tick : ceil(raw, 10000n * tick) * tick;
    requireThat(price > 0n, 'DERIVATIVE_PRICE', 'Liquidation price rounded to zero');
    this.#fill(-quantity, checked(price, 'liquidation price'), event, 'liquidation');
    this.#halted = true; this.#liquidations++;
  }
  #event(event) {
    const time = BigInt(event.time); this.#time = time; this.#advanceCancel(time);
    if (event.type === 'mark') {
      this.#mark = { price: BigInt(event.price), time }; this.#liquidate(event);
    } else if (event.type === 'funding') {
      if (this.#quantity !== 0n) {
        requireThat(this.#fresh(this.#mark, this.config.maxMarkAgeMs), 'STALE_MARK', 'Open exposure at funding requires a fresh risk mark');
        const rate = BigInt(event.rate.numerator), quantity = this.#quantity;
        const transfer = rate === 0n ? 0n : -sign(quantity) * sign(rate) * this.#charge(quantity, BigInt(event.price), abs(rate), BigInt(event.rate.denominator));
        this.#post(transfer, 'funding', event.id, event.time); this.#funding += transfer;
        this.#liquidate(event);
      }
    } else if (event.type === 'settlement') {
      this.#cancel('cancelled-expiry');
      if (this.#quantity !== 0n) this.#fill(-this.#quantity, BigInt(event.price), event, 'settlement');
      this.#mark = { price: BigInt(event.price), time }; this.#settled = true;
    } else {
      this.#quote = { ...event, time };
      const expired = this.config.contract.kind === 'future' && time >= BigInt(this.config.contract.expiryTime);
      if (this.#working !== null && !expired && !this.#halted && this.#fresh(this.#mark, this.config.maxMarkAgeMs)) {
        const record = this.#working, order = record.order;
        if (this.#runtime.engine.eligible(time, order, BigInt(event.bid), BigInt(event.ask))) {
          const buy = order.side.$ === 'Buy', lots = min(order.remaining, BigInt(buy ? event.askLots : event.bidLots));
          if (lots > 0n) {
            const delta = buy ? lots : -lots, price = BigInt(buy ? event.ask : event.bid);
            if (!this.#canFill(delta, price)) this.#cancel('rejected-margin-at-fill');
            else {
              this.#fill(delta, price, event, 'trade', String(order.id));
              record.order = this.#runtime.engine.fill_order(order, lots);
              if (record.order.remaining === 0n) { record.status = 'filled'; this.#working = null; }
              this.#orders.set(record.order.id,record);
              this.#liquidate(event);
            }
          }
        }
      }
    }
    this.#recordValuation(event.id);
  }
  #recordValuation(eventId = null) {
    const snapshot = this.snapshot();
    this.#valuations.push({ time: String(this.#time), eventId, equity: snapshot.equity, cash: this.#wallet, quantity: this.#quantity });
    if (snapshot.equity === null) this.#staleHistory = true;
    else {
      if (snapshot.equity > this.#peak) this.#peak = snapshot.equity;
      if (this.#peak - snapshot.equity > this.#drawdown) this.#drawdown = this.#peak - snapshot.equity;
    }
  }
  #guard(work) {
    requireThat(this.#errors.length === 0, 'INVALID_REPLAY', 'A failed derivative replay cannot continue');
    try { return this.#recording.disk ? this.#recording.transaction(work) : work(); }
    catch (error) { this.#errors.push({ code: error.code ?? 'ERROR', message: String(error.message) }); if (this.#recording.disk) this.#recording.abort(); throw error; }
  }
  advanceTo(time) {
    return this.#guard(() => {
      const now = nat(time, 'venue time');
      requireThat(!this.#finished && (this.#time === null || now >= this.#time), 'VENUE_TIME', 'Time must advance on an unfinished venue');
      requireThat(now >= BigInt(this.#startTime) && now <= BigInt(this.#endTime), 'DATA_COVERAGE', 'Decision is outside venue window');
      while (this.#cursor < this.#data.events.length && BigInt(this.#data.events[this.#cursor].time) <= now) this.#event(this.#data.events[this.#cursor++]);
      const advanced = this.#time !== now;
      this.#advanceCancel(now); this.#time = now;
      // Retain valuation gaps at decisions between market events, even after recovery.
      if (advanced) this.#recordValuation();
    });
  }
  setTarget(target, time) {
    return this.#guard(() => {
      const desired = integer(target, 'target'), now = nat(time, 'decision time');
      requireThat(!this.#finished && now === this.#time, 'VENUE_TIME', 'Advance venue before setting a target');
      const expired = this.config.contract.kind === 'future' && now >= BigInt(this.config.contract.expiryTime);
      const delta = desired - this.#quantity;
      if (this.#working !== null) {
        const record = this.#working, order = record.order;
        const pending = (order.side.$ === 'Buy' ? 1n : -1n) * order.remaining;
        if (pending === delta) return;
        record.order = this.#runtime.engine.request_if(true, order, checked(now + BigInt(this.config.cancelLatencyMs), 'cancel arrival'));
        this.#advanceCancel(now);
        if (this.#working !== null) return;
      }
      if (delta === 0n) return;
      const rejection = this.#halted ? 'rejected-halted' : expired ? 'rejected-expired' : abs(desired) > BigInt(this.config.maxPositionLots) ? 'rejected-position-cap'
        : !this.#fresh(this.#quote, this.config.maxQuoteAgeMs) || !this.#fresh(this.#mark, this.config.maxMarkAgeMs) ? 'rejected-stale-market' : null;
      if (rejection) { this.#orders.set(++this.#orderCount,{ target, time, status: rejection, order: null }); return; }
      const buy = delta > 0n, tick = BigInt(this.instrument.priceTick), bps = BigInt(this.config.slippageBps);
      const raw = BigInt(buy ? this.#quote.ask : this.#quote.bid) * (buy ? 10000n + bps : 10000n - bps);
      const limit = checked(buy ? ceil(raw, 10000n * tick) * tick : raw / (10000n * tick) * tick, 'order limit');
      requireThat(limit > 0n, 'DERIVATIVE_PRICE', 'Order limit rounded to zero');
      if (!this.#canFill(delta, limit)) { this.#orders.set(++this.#orderCount,{ target, time, status: 'rejected-margin', order: null }); return; }
      const order = { $: 'Order', id: BigInt(++this.#orderCount), side: { $: buy ? 'Buy' : 'Sell' }, limit,
        accepted: checked(abs(delta), 'order lots'), remaining: abs(delta), filled: 0n, cancelled: 0n,
        decision: now, arrival: checked(now + BigInt(this.config.orderLatencyMs), 'order arrival'), cancel_at: { $: 'None' } };
      this.#working = { target, time, status: 'working', order }; this.#orders.set(order.id,this.#working);
    });
  }
  snapshot() {
    const quantity = this.#quantity, fresh = this.#fresh(this.#mark, this.config.maxMarkAgeMs);
    const unrealized = quantity === 0n ? 0n : fresh ? this.#unrealized() : null;
    const equity = unrealized === null || this.#errors.length ? null : this.#wallet + unrealized;
    const order = this.#working?.order ?? null;
    const initial = quantity === 0n ? 0n : fresh ? this.#charge(quantity, this.#mark.price, BigInt(this.config.initialMarginBps)) : null;
    let reserved = order === null ? 0n : null;
    if (order && fresh) {
      const delta = (order.side.$ === 'Buy' ? 1n : -1n) * order.remaining;
      const preview = this.#preview(delta, order.limit);
      const needed = this.#charge(quantity + delta, this.#mark.price, BigInt(this.config.initialMarginBps))
        + this.#charge(delta, order.limit, BigInt(this.config.feeBps)) - preview.realized - this.#unrealized(preview.positions) + unrealized - initial;
      reserved = needed > 0n ? needed : 0n;
    }
    return freeze({ ledger: { cash: this.#wallet, quantity }, equity, unrealizedPnl: unrealized,
      orders: order ? [{ id: order.id, side: order.side.$ === 'Buy' ? 'buy' : 'sell', limit: order.limit, remaining: order.remaining, cancellationPending: order.cancel_at.$ === 'Some' }] : [],
      funding: { status: this.config.contract.kind === 'perpetual' ? 'scheduled' : 'not-applicable', accrued: this.#funding },
      margin: { model: 'single-instrument-cross-collateral', initial, reserved,
        available: equity === null || initial === null || reserved === null ? null : equity - initial - reserved,
        maintenance: quantity === 0n ? 0n : fresh ? this.#charge(quantity, this.#mark.price, BigInt(this.config.maintenanceMarginBps)) : null, halted: this.#halted } });
  }
  finish(time) {
    requireThat(!this.#finished, 'VENUE_REUSED', 'Venue already finished');
    if (time !== null && this.#errors.length === 0) this.advanceTo(time);
    requireThat(time !== null || this.#time === null, 'VENUE_TIME', 'Null finish is only valid for an empty replay');
    this.#finished = true;
  }
  abort() { this.#recording.abort(); this.#errors.push({code:'REPLAY_ABORTED',message:'Replay was aborted'}); }
  report({detail = this.#recording.disk ? 'summary' : 'full'} = {}) {
    requireThat(['summary','full'].includes(detail),'REPORT_DETAIL','Report detail must be summary or full');
    if (this.#recording.disk) this.#recording.assertValid();
    requireThat(this.#finished || this.#errors.length > 0, 'VENUE_UNFINISHED', 'Finish the replay before reporting');
    const account = this.snapshot(), issues = [...this.#errors];
    if (account.equity === null && issues.length === 0) issues.push({ code: 'STALE_MARK', message: 'Terminal open position has no fresh mark' });
    if (this.#staleHistory) issues.push({ code: 'STALE_MARK_HISTORY', message: 'Open exposure crossed an unmarked market event or decision time' });
    const valid = issues.length === 0, initial = BigInt(this.config.initialCash), equity = valid ? account.equity : null;
    const drawdown = this.#drawdown;
    const net = equity === null ? null : equity - initial;
    requireThat(this.#wallet === initial + this.#realized + this.#funding - this.#fees, 'RECONCILIATION', 'Wallet does not reconcile to P&L, funding and fees');
    this.#traceHash ??= this.#recording.contentHash(['orders','fills','postings','valuations']);
    const audit = this.#recording.disk ? this.#recording.seal({manifest:this.manifest,config:this.config,verification:this.#runtime.verification}) : null;
    return copy({ status: valid ? 'valid-under-declared-model' : 'invalid-data-quality', dataQuality: { status: valid ? 'accepted' : 'critical', issues },
      manifest: this.manifest, config: this.config, terminal: { time: this.#time, ...account, settled: this.#settled, bankrupt: this.#wallet < 0n, deficit: this.#wallet < 0n ? -this.#wallet : 0n },
      performance: { terminalEquity: equity, netPnl: net, totalReturn: net === null ? null : { numerator: net, denominator: initial },
        realizedPnl: this.#realized, unrealizedPnl: account.unrealizedPnl, fees: this.#fees, funding: this.#funding, liquidations: this.#liquidations, maxDrawdown: valid ? drawdown : null, sharpe: null },
      ...(detail==='full' ? {orders:[...this.#orders.values()],fills:this.#fills.slice(),postings:this.#postings.slice(),valuations:this.#valuations.slice()} : {}),
      ...(audit ? {audit} : {}), traceHash:this.#traceHash,
      verification: { build: this.#runtime.verification, sources: this.#runtime.sources,
        scope: 'Bend wallet postings and order primitives; host payoff, funding, margin, liquidation and orchestration are reconciled/tested, not formally proved' } });
  }
}
