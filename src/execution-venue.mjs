import { Backtest } from './framework.mjs';
import { hash, nat, requireThat, freeze as freezeData } from './core.mjs';
import { validateTicks } from './data.mjs';
import { assertQuoteInstrument, isQuoteDataset } from './quote-data.mjs';
import { affordableLots, cappedLots } from './policies.mjs';

/** Bend cash venue. No InformationSource or source observation enters this module. */
export class QuoteExecutionVenue {
  #iterator; #next; #hasTickId; #time = null; #quote = null; #sequence = 0n; #orderId = 0n;
  #maxPositionLots; #finished = false; #terminalSequence; #submitAtEnd;
  constructor(options) {
    requireThat(options && Object.keys(options).every(key => ['id', 'config', 'ticks', 'maxPositionLots', 'traceMode', 'orderStorage', 'submitAtEnd', 'auditDirectory'].includes(key)), 'VENUE_OPTION', 'Unknown quote execution option');
    const { id, config, ticks, maxPositionLots, traceMode, orderStorage, submitAtEnd = true, auditDirectory } = options;
    requireThat(typeof submitAtEnd === 'boolean', 'VENUE_OPTION', 'submitAtEnd must be boolean');
    requireThat(typeof id === 'string' && id.length > 0, 'EXECUTION_VENUE', 'Venue identity is required');
    let datasetHash;
    if (isQuoteDataset(ticks)) {
      assertQuoteInstrument(ticks,config.instrument);
      this.#iterator = ticks.rows(); this.#hasTickId = id=>ticks.hasId(id); datasetHash=ticks.manifest.datasetHash;
    } else {
      const quotes = freezeData(validateTicks(ticks, { instrument: config.instrument })), ids = new Set(quotes.map(tick=>tick.id));
      this.#iterator = quotes.values(); this.#hasTickId = id=>ids.has(id); datasetHash=hash(quotes);
    }
    this.#next = this.#iterator.next();
    this.backtest = new Backtest(config, { traceMode, orderStorage, auditDirectory });
    this.instrument = this.backtest.config.instrument;
    nat(maxPositionLots, 'maxPositionLots'); this.#maxPositionLots = maxPositionLots;
    this.#submitAtEnd = submitAtEnd;
    const { manifest: _strategyManifest, ...executionConfig } = this.backtest.config;
    this.manifest = freezeData({ id, model: 'cash-spot-fifo-quote-v1', instrument: this.instrument,
      datasetHash, configHash: hash({ config: this.backtest.config, maxPositionLots, submitAtEnd }),
      executionPolicyHash: hash({ config: executionConfig, maxPositionLots, submitAtEnd }),
      funding: 'unsupported', margin: 'cash-only-no-leverage' });
    Object.freeze(this);
  }
  #base(id, time) {
    // Input IDs have no reserved namespace, including ticks still in the future.
    while (this.#hasTickId(id)) id += '-';
    return { id, time, sequence: String(++this.#sequence), symbol: this.instrument.symbol, currency: this.instrument.currency };
  }
  advanceTo(time) {
    const now = nat(time, 'venue time');
    requireThat(!this.#finished && (this.#time === null || now >= this.#time), 'VENUE_TIME', 'Venue time must advance on an unfinished replay');
    while (!this.#next.done && BigInt(this.#next.value.time) <= now) {
      const tick = this.#next.value;
      this.backtest.step({ ...tick, sequence: String(++this.#sequence) });
      this.#quote = tick;
      this.#next = this.#iterator.next();
    }
    if (this.backtest.lastTime !== now) this.backtest.step({ ...this.#base(`venue-clock-${this.#sequence + 1n}`, time), type: 'clock' });
    this.#time = now;
  }
  snapshot() {
    const ledger = this.backtest.ledger, mark = this.backtest.mark;
    const stale = !mark || this.#time - mark.time > BigInt(this.backtest.config.maxQuoteAgeMs);
    return freezeData({ ledger: { cash: ledger.cash, quantity: ledger.quantity },
      orders: this.backtest.workingOrders.map(order => ({ id: order.id, side: order.side.$ === 'Buy' ? 'buy' : 'sell',
        limit: order.limit, remaining: order.remaining, cancellationPending: order.cancel_at.$ === 'Some' })),
      equity: ledger.quantity > 0n && stale ? null : ledger.cash + ledger.quantity * (mark?.price ?? 0n),
      funding: { status: 'unsupported', accrued: null }, margin: { model: 'cash-only', leverage: false } });
  }
  setTarget(target, time) { this.reconcileTarget(target, time, this.#quote); }
  #targetOrders(target, quote) {
    const { cash, quantity: position } = this.backtest.ledger;
    const feePerLot = this.backtest.config.feePerLot, cap = BigInt(this.#maxPositionLots);
    const desired = BigInt(cappedLots(target, this.#maxPositionLots, this.#maxPositionLots));
    const bid = nat(quote.bid, 'bid', true), ask = nat(quote.ask, 'ask', true);
    const delta = desired - position, side = delta > 0n ? 'buy' : 'sell', distance = delta < 0n ? -delta : delta;
    const active = this.backtest.workingOrders;
    const cancel = order => ({ type: 'cancel', orderId: String(order.id) });
    if (active.length) {
      // A pending cancellation can still fill. Wait before adding exposure.
      if (active.some(order => order.cancel_at.$ === 'Some')) return active.filter(order => order.cancel_at.$ !== 'Some').map(cancel);
      const total = active.reduce((sum, order) => sum + order.remaining, 0n);
      const stale = delta === 0n || total > distance || active.some(order =>
        (order.side.$ === 'Buy' ? 'buy' : 'sell') !== side || (side === 'buy' ? order.limit < ask : order.limit > bid));
      return stale ? active.map(cancel) : [];
    }
    if (delta === 0n) return [];
    const limit = side === 'buy' ? ask : bid;
    if (side === 'sell' && limit < BigInt(feePerLot)) return [];
    const budget = side === 'buy' ? affordableLots(String(cash), '0', String(limit), feePerLot) : String(position);
    const headroom = side === 'buy' ? (position < cap ? cap - position : 0n) : position;
    const quantity = cappedLots(String(distance), budget, String(headroom));
    return quantity === '0' ? [] : [{ type: 'submit', side, limit: String(limit), quantity }];
  }
  // Internal seam used by the explicit bar-price proxy for venue-owned collars.
  reconcileTarget(target, time, quote) {
    nat(target, 'target');
    requireThat(!this.#finished && this.#time === nat(time, 'decision time'), 'VENUE_TIME', 'Advance venue before setting a target');
    if (!quote || (!this.#submitAtEnd && this.#next.done) || this.#time - BigInt(quote.time) > BigInt(this.backtest.config.maxQuoteAgeMs)) return;
    const decisions = this.#targetOrders(target, quote);
    for (const decision of decisions) {
      const event = { ...decision, ...this.#base(`strategy-${this.#sequence + 1n}`, time) };
      if (decision.type === 'submit') event.orderId = String(++this.#orderId);
      this.backtest.step(event);
    }
  }
  finish(time) {
    requireThat(!this.#finished, 'VENUE_REUSED', 'Venue already finished');
    if (time !== null) this.advanceTo(time);
    this.#finished = true; this.#terminalSequence = this.backtest.lastSequence;
    this.#iterator.return?.();
  }
  abort() { this.#iterator.return?.(); this.backtest.abort(); }
  report(options) {
    requireThat(this.#finished && this.backtest.lastSequence === this.#terminalSequence, 'VENUE_REPLAY_CHANGED', 'Venue reports require an unchanged completed replay');
    return this.backtest.report(options);
  }
}
