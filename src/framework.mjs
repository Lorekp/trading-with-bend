import { verifyBendRuntime } from './bend-runtime.mjs';
import { BacktestError, freeze, canonical, checked, hash, immutableCopy, json, nat, requireThat } from './core.mjs';
import { checkpointSources, sourceManifest } from './provenance.mjs';
import { ReplayRecording, readReplayAudit } from './recording.mjs';

const text = (s, name) => requireThat(typeof s === 'string' && s.length > 0, 'MISSING_FIELD', `${name} is required`);
function keys(object, allowed, name) {
  requireThat(object && typeof object === 'object' && !Array.isArray(object), 'INVALID_OBJECT', `${name} must be an object`);
  for (const key of Object.keys(object)) requireThat(allowed.includes(key), 'UNSUPPORTED_FIELD', `${name}.${key} is unsupported`);
}
export function orders(state) {
  const result = [];
  for (let list = state.orders; list.$ === 'Con'; list = list.tail) result.push(list.head);
  return result;
}
export function validateConfig(config) {
  keys(config, ['instrument', 'initialCash', 'feePerLot', 'orderLatencyMs', 'cancelLatencyMs', 'maxQuoteAgeMs', 'manifest'], 'config');
  keys(config.instrument, ['symbol', 'currency', 'lotSize', 'priceTick'], 'instrument');
  text(config.instrument.symbol, 'symbol'); text(config.instrument.currency, 'currency');
  text(config.instrument.lotSize, 'lotSize');
  requireThat(/^[1-9][0-9]*(\.[0-9]+)?$|^0\.[0-9]*[1-9][0-9]*$/.test(config.instrument.lotSize), 'INVALID_LOT_SIZE', 'lotSize must be a positive decimal descriptor');
  for (const name of ['initialCash', 'feePerLot', 'orderLatencyMs', 'cancelLatencyMs', 'maxQuoteAgeMs']) nat(config[name], name, name === 'initialCash');
  nat(config.instrument.priceTick, 'priceTick', true);
  keys(config.manifest, ['datasetVersion', 'strategyArtifact', 'evaluationProtocol', 'seed'], 'manifest');
  for (const name of ['datasetVersion', 'strategyArtifact', 'evaluationProtocol', 'seed']) text(config.manifest[name], `manifest.${name}`);
  return structuredClone(config);
}
function validateEvent(event, config) {
  const common = ['id', 'type', 'time', 'sequence', 'symbol', 'currency'];
  const fields = { submit: ['orderId', 'side', 'limit', 'quantity'], cancel: ['orderId'], tick: ['bid', 'ask', 'bidLots', 'askLots', 'sourceTime'], clock: [] };
  requireThat(Object.hasOwn(fields, event?.type), 'UNSUPPORTED_EVENT', `Unsupported event ${event?.type}`);
  keys(event, [...common, ...fields[event.type]], 'event');
  text(event.id, 'event.id');
  const time = nat(event.time, 'time'); nat(event.sequence, 'sequence');
  requireThat(event.symbol === config.instrument.symbol && event.currency === config.instrument.currency, 'UNIT_MISMATCH', 'Event instrument/currency differs from the configured market');
  if (event.type === 'submit' || event.type === 'cancel') nat(event.orderId, 'orderId', true);
  if (event.type === 'submit') {
    requireThat(['buy', 'sell'].includes(event.side), 'INVALID_SIDE', 'side must be buy or sell');
    nat(event.quantity, 'quantity', true);
    requireThat(nat(event.limit, 'limit', true) % BigInt(config.instrument.priceTick) === 0n, 'PRICE_TICK', 'Limit is off tick');
    checked((BigInt(event.limit) + BigInt(config.feePerLot)) * BigInt(event.quantity), 'order notional plus fees');
  }
  if (event.type === 'tick') {
    const bid = nat(event.bid, 'bid', true), ask = nat(event.ask, 'ask', true);
    nat(event.bidLots, 'bidLots'); nat(event.askLots, 'askLots');
    const sourceTime = nat(event.sourceTime, 'sourceTime');
    requireThat(bid <= ask, 'CROSSED_QUOTE', 'bid exceeds ask');
    requireThat(bid % BigInt(config.instrument.priceTick) === 0n && ask % BigInt(config.instrument.priceTick) === 0n, 'PRICE_TICK', 'Quote is off tick');
    requireThat(sourceTime === time, 'NON_EXECUTABLE_QUOTE', 'This replay model requires sourceTime = exchange event time; delayed or stale observations cannot supply liquidity');
  }
}
function verifyState(state, config, os = orders(state)) {
  const fee = BigInt(config.feePerLot);
  let cashReserved = 0n, quantityReserved = 0n;
  checked(state.ledger.cash, 'cash'); checked(state.ledger.quantity, 'quantity');
  for (const o of os) {
    requireThat(o.accepted === o.remaining + o.filled + o.cancelled, 'ORDER_ACCOUNTING', 'Order quantities do not reconcile');
    requireThat(o.remaining >= 0n && o.filled >= 0n && o.cancelled >= 0n, 'ORDER_ACCOUNTING', 'Negative order quantity');
    if (o.side.$ === 'Buy') cashReserved += o.remaining * (o.limit + fee);
    else if (o.side.$ === 'Sell') quantityReserved += o.remaining;
  }
  requireThat(cashReserved <= state.ledger.cash && quantityReserved <= state.ledger.quantity, 'RESERVATION_BREACH', 'Outstanding reservations exceed capital');
  return { cashReserved, quantityReserved };
}
function sameOrder(left, right) {
  return left === right || left.$ === right.$ && left.id === right.id && left.side.$ === right.side.$ && left.limit === right.limit &&
    left.accepted === right.accepted && left.remaining === right.remaining && left.filled === right.filled && left.cancelled === right.cancelled &&
    left.decision === right.decision && left.arrival === right.arrival && left.cancel_at.$ === right.cancel_at.$ && left.cancel_at.value === right.cancel_at.value;
}
function orderList(values) { return values.reduceRight((tail, head) => ({ $: 'Con', head, tail }), { $: 'Nil' }); }
export class Backtest {
  #engine;
  #sources;
  #verification;
  #config;
  #state;
  #events;
  #trace;
  #fills;
  #valuations;
  #errors;
  #seen;
  #orderIds;
  #lastTime;
  #lastSequence;
  #mark;
  #options;
  #reservations;
  #orders;
  #archive;
  #closedCancels;
  #allOrders;
  #publicState;
  #workingOrders;
  #activeArchive = new Map();
  #recording;
  #fees = 0n;
  #peak;
  #drawdown;
  get sources() { return this.#sources; }
  get verification() { return this.#verification; }
  get config() { return this.#config; }
  get state() {
    if (this.#options.orderStorage === 'all') return this.#state;
    return this.#publicState ??= freeze({ $: 'State', ledger: this.#state.ledger, orders: orderList(this.orders) });
  }
  get ledger() { return this.#state.ledger; }
  get mark() { return this.#mark; }
  get lastTime() { return this.#lastTime; }
  get lastSequence() { return this.#lastSequence; }
  get events() { return Object.freeze(this.#events.slice()); }
  get trace() { return Object.freeze(this.#trace.slice()); }
  get fills() { return Object.freeze(this.#fills.slice()); }
  get valuations() { return Object.freeze(this.#valuations.slice()); }
  get errors() { return Object.freeze(this.#errors.slice()); }
  get options() { return this.#options; }
  get recordingCounts() { return Object.freeze({ events:this.#events.length, fills:this.#fills.length, trace:this.#trace.length, valuations:this.#valuations.length }); }
  get orders() { return this.#options.orderStorage === 'all' ? this.#orders : this.#allOrders ??= freeze([...this.#archive.values()]); }
  get workingOrders() { return this.#options.orderStorage === 'active' ? this.#orders : this.#workingOrders ??= freeze(this.#orders.filter(order => order.remaining > 0n)); }
  constructor(config, options = {}) {
    keys(options, ['traceMode', 'orderStorage', 'auditDirectory'], 'options');
    const traceMode = options.traceMode === undefined ? (options.auditDirectory === undefined ? 'full' : 'compact') : options.traceMode;
    // Historical orders belong in the audit archive, outside Bend matching and
    // reservation scans. 'all' is retained only as the bounded reference mode.
    const orderStorage = options.orderStorage === undefined ? 'active' : options.orderStorage;
    requireThat(traceMode === 'full' || traceMode === 'compact', 'TRACE_MODE', 'traceMode must be full or compact');
    requireThat(orderStorage === 'all' || orderStorage === 'active', 'ORDER_STORAGE', 'orderStorage must be all or active');
    requireThat(options.auditDirectory === undefined || orderStorage === 'active' && traceMode === 'compact', 'AUDIT_OPTIONS', 'Disk recording requires active orders and compact trace');
    const { engine, sources, verification } = verifyBendRuntime();
    this.#engine = engine; this.#sources = sources; this.#verification = verification;
    this.#config = freeze(validateConfig(config));
    this.#state = freeze(this.#engine.initial(BigInt(config.initialCash)));
    this.#orders = freeze(orders(this.#state));
    this.#options = freeze({ traceMode, orderStorage }); this.#reservations = freeze(verifyState(this.#state, this.#config));
    this.#recording = new ReplayRecording(options.auditDirectory);
    this.#archive = this.#recording.map('orders'); this.#closedCancels = new Map(); this.#allOrders = null; this.#publicState = null; this.#workingOrders = null;
    this.#events = this.#recording.series('events'); this.#trace = this.#recording.series('trace');
    this.#fills = this.#recording.series('fills'); this.#valuations = this.#recording.series('valuations'); this.#errors = [];
    this.#seen = this.#recording.map('event-identities'); this.#orderIds = this.#recording.map('order-identities');
    this.#lastTime = null; this.#lastSequence = null; this.#mark = null;
    this.#peak = BigInt(config.initialCash); this.#drawdown = { numerator: 0n, denominator: this.#peak };
  }
  step(event) {
    try { return this.#apply(event); }
    catch (error) {
      this.#errors.push(freeze({ eventId: typeof event?.id === 'string' ? event.id : null, code: error.code || 'ERROR', message: String(error.message || error) }));
      if (this.#recording.disk) this.#recording.abort();
      throw error;
    }
  }
  #apply(event) {
    this.#recording.assertWritable();
    const Engine = this.#engine;
    validateEvent(event, this.#config);
    const digest = hash(event);
    if (this.#seen.has(event.id)) {
      requireThat(this.#seen.get(event.id) === digest, 'EVENT_ID_COLLISION', 'A previously seen event ID has different content');
      return { duplicate: true };
    }
    const t = BigInt(event.time), seq = BigInt(event.sequence), fee = BigInt(this.#config.feePerLot);
    requireThat(this.#lastTime === null || t >= this.#lastTime, 'OUT_OF_ORDER', 'Timestamps must not decrease');
    requireThat(this.#lastSequence === null || seq > this.#lastSequence, 'OUT_OF_ORDER', 'Sequence must strictly increase');
    // Stage every update. Failure cannot partially commit an event.
    let state = Engine.advance(this.#state, t), mark = this.#mark, status = 'applied';
    const before = state.ledger, previousOrders = orders(state), newFills = [];
    const archiveUpdates = new Map();
    let finalOrders;
    try {
      if (this.#options.orderStorage === 'active') {
        // Completed orders reserve nothing, but delayed cancellation metadata is
        // still part of the authoritative archive and full trace. Advance only
        // those few archived orders with a pending cancellation, through Bend.
        for (const [id, order] of this.#closedCancels) {
          if (order.cancel_at.value <= t) {
            const advanced = Engine.advance({ $: 'State', ledger: before, orders: orderList([order]) }, t);
            verifyState(advanced, this.#config);
            archiveUpdates.set(id, orders(advanced)[0]);
          }
        }
      }
      if (event.type === 'submit') {
        requireThat(!this.#orderIds.has(event.orderId), 'DUPLICATE_ORDER', 'Order IDs cannot be reused, including rejected orders');
        const arrival = checked(t + BigInt(this.#config.orderLatencyMs), 'arrival');
        const result = Engine.submit(state, BigInt(event.orderId), { $: event.side === 'buy' ? 'Buy' : 'Sell' }, BigInt(event.limit), BigInt(event.quantity), t, arrival, fee);
        state = result.state; status = result.$ === 'Accepted' ? 'accepted' : 'rejected-capital-or-fee';
      } else if (event.type === 'cancel') {
        const id = BigInt(event.orderId), pending = previousOrders.some(order => order.id === id);
        const archived = pending ? null : archiveUpdates.get(id) ?? this.#archive.get(id);
        requireThat(pending || this.#options.orderStorage === 'active' && archived, 'UNKNOWN_ORDER', 'Cannot cancel an unaccepted order');
        const arrival = checked(t + BigInt(this.#config.cancelLatencyMs), 'cancel arrival');
        if (pending) {
          state = Engine.request_cancel(state, id, arrival);
          state = Engine.advance(state, t);
        } else {
          const closed = Engine.advance(Engine.request_cancel({ $: 'State', ledger: before, orders: orderList([archived]) }, id, arrival), t);
          verifyState(closed, this.#config);
          archiveUpdates.set(id, orders(closed)[0]);
        }
      } else if (event.type === 'tick') {
        const bid = BigInt(event.bid), ask = BigInt(event.ask);
        state = Engine.tick(state, t, bid, ask, BigInt(event.bidLots), BigInt(event.askLots), fee);
        const after = orders(state); finalOrders = after;
        for (let i = 0; i < after.length; i++) {
          const o = after[i], lots = o.filled - previousOrders[i].filled;
          if (lots === 0n) continue;
          const buy = o.side.$ === 'Buy', price = buy ? ask : bid;
          requireThat(t > o.decision && t >= o.arrival, 'CAUSALITY', 'Fill precedes eligible time');
          requireThat(buy ? price <= o.limit : price >= o.limit, 'LIMIT_VIOLATION', 'Fill violates limit');
          newFills.push({ id: `${event.id}/order/${o.id}`, marketEventId: event.id, orderId: o.id,
            side: buy ? 'buy' : 'sell', quantity: lots, price, fee: lots * fee,
            decisionTime: o.decision, exchangeArrival: o.arrival, executionTime: t, reportTime: t,
            sequence: seq, liquidityBucket: `${event.id}/${buy ? 'ask' : 'bid'}` });
        }
        for (const side of ['buy', 'sell']) requireThat(newFills.filter(f => f.side === side).reduce((sum, f) => sum + f.quantity, 0n) <= BigInt(side === 'buy' ? event.askLots : event.bidLots), 'LIQUIDITY', 'Shared liquidity exceeded');
        mark = { price: bid, time: t };
      }
      finalOrders ??= orders(state);
      const reservations = verifyState(state, this.#config, finalOrders);
      const expected = newFills.reduce((a, f) => ({ cash: a.cash + (f.side === 'buy' ? -f.price * f.quantity : f.price * f.quantity) - f.fee, quantity: a.quantity + (f.side === 'buy' ? f.quantity : -f.quantity) }), { cash: before.cash, quantity: before.quantity });
      requireThat(expected.cash === state.ledger.cash && expected.quantity === state.ledger.quantity, 'LEDGER_MISMATCH', 'Postings disagree with the Bend ledger');
      const equity = mark ? checked(state.ledger.cash + state.ledger.quantity * mark.price, 'equity') : state.ledger.cash;
      if (this.#options.orderStorage === 'active') {
        for (const order of finalOrders) archiveUpdates.set(order.id, order);
        const expectedWorking = finalOrders.filter(order => order.remaining > 0n);
        const compact = Engine.compact_state(state), compactOrders = orders(compact);
        requireThat(compact.ledger.cash === state.ledger.cash && compact.ledger.quantity === state.ledger.quantity &&
          compactOrders.length === expectedWorking.length && compactOrders.every((order, index) => sameOrder(order, expectedWorking[index])),
        'COMPACTION_MISMATCH', 'Bend compaction changed ledger or live order FIFO/content');
        state = compact; finalOrders = compactOrders;
      }
      // The generated host bridge decodes fresh objects even when no ledger or
      // order field changed. Reuse only exactly equal, already immutable data;
      // the Bend result has still passed every accounting/causality check above.
      if (state.ledger.$ === this.#state.ledger.$ && state.ledger.cash === this.#state.ledger.cash && state.ledger.quantity === this.#state.ledger.quantity &&
          finalOrders.length === this.#orders.length && finalOrders.every((order, index) => sameOrder(order, this.#orders[index]))) {
        state = this.#state; finalOrders = this.#orders;
      }
      // Persist one validated event before publishing the new live state. A failed
      // write poisons the recording and leaves the previous account state visible.
      const auditTrace = { eventId: event.id, sequence: seq, time: t, status, ledger: state.ledger,
        reservations, fills: newFills.map(f => f.id) };
      this.#recording.transaction(() => {
        for (const [id, order] of archiveUpdates) {
          const previous = this.#activeArchive.get(id) ?? this.#archive.get(id);
          if (!previous || !sameOrder(previous, order)) this.#archive.set(id, order);
        }
        this.#seen.set(event.id, digest); if (event.type === 'submit') this.#orderIds.add(event.orderId);
        this.#events.push(immutableCopy(event)); this.#fills.push(...freeze(newFills));
        if (this.#options.traceMode === 'full') auditTrace.orders = this.#options.orderStorage === 'all' ? finalOrders : [...this.#archive.values()];
        this.#trace.push(freeze(auditTrace));
        if (event.type === 'tick') this.#valuations.push(freeze({ time: t, equity, cash: state.ledger.cash, quantity: state.ledger.quantity, mark: mark.price }));
      });
      // Commit only after accounting and recording checks pass.
      this.#state = freeze(state); this.#mark = freeze(mark); this.#lastTime = t; this.#lastSequence = seq;
      if (this.#options.orderStorage === 'active' && finalOrders !== this.#orders) this.#activeArchive = new Map(finalOrders.map(order => [order.id, order]));
      this.#orders = freeze(finalOrders);
      this.#reservations = freeze(reservations);
      for (const [id, order] of archiveUpdates) {
        const immutable = freeze(order);
        this.#allOrders = null;
        if (order.remaining === 0n && order.cancel_at.$ === 'Some' && order.cancel_at.value > t) this.#closedCancels.set(id, immutable);
        else this.#closedCancels.delete(id);
      }
      this.#publicState = null; this.#workingOrders = null;
      this.#fees += newFills.reduce((sum,fill)=>sum+fill.fee,0n);
      if (event.type === 'tick') {
        if (equity > this.#peak) this.#peak = equity;
        const loss = this.#peak - equity;
        if (loss * this.#drawdown.denominator > this.#drawdown.numerator * this.#peak) this.#drawdown = {numerator:loss,denominator:this.#peak};
      }
      return { duplicate: false, status, fills: newFills.length ? structuredClone(newFills) : [] };
    } catch (error) {
      if (error instanceof BacktestError) throw error;
      throw new BacktestError('BEND_RUNTIME', String(error));
    }
  }
  run(events) {
    try { for (const event of events) this.step(event); return this; }
    catch(error) { this.#recording.abort(); throw error; }
  }
  checkpoint() {
    this.#recording.assertValid();
    // Event-sourced checkpoint: replay reconstructs reservations, queues, cancellations,
    // deduplication identities, valuations and all other continuation state.
    const body = this.#recording.disk
      ? { format: 'bend-backtest-checkpoint-v3', config: this.#config, options: this.#options, audit: this.#recording.checkpoint({purpose:'checkpoint'}), errors: this.#errors, sources: checkpointSources(this.#sources) }
      : { format: 'bend-backtest-checkpoint-v2', config: this.#config, options: this.#options, events: this.#events.slice(), errors: this.#errors, sources: checkpointSources(this.#sources) };
    return JSON.parse(json({ ...body, checksum: hash(body) }));
  }
  static resume(checkpoint, options = {}) {
    const { checksum, ...body } = checkpoint;
    requireThat(['bend-backtest-checkpoint-v2','bend-backtest-checkpoint-v3'].includes(body.format) && checksum === hash(body), 'CHECKPOINT_CORRUPT', 'Checkpoint format or checksum invalid');
    requireThat(canonical(body.sources) === canonical(checkpointSources(sourceManifest())), 'CHECKPOINT_VERSION', 'Checkpoint source artifacts differ from this engine');
    requireThat(Object.keys(options).every(key=>key==='auditDirectory'), 'CHECKPOINT_OPTIONS', 'Resume options contain only a new auditDirectory');
    requireThat(body.format !== 'bend-backtest-checkpoint-v3' || typeof options.auditDirectory === 'string', 'CHECKPOINT_OPTIONS', 'Disk resume requires a new auditDirectory');
    const run = new Backtest(body.config, {...body.options,...options}).run(body.format === 'bend-backtest-checkpoint-v3' ? readReplayAudit(body.audit,'events') : body.events);
    run.#errors = freeze(structuredClone(body.errors)).slice();
    return run;
  }
  abort() { this.#recording.abort(); }
  report({ detail = this.#recording.disk ? 'summary' : 'full' } = {}) {
    this.#recording.assertValid();
    requireThat(detail === 'full' || detail === 'summary', 'REPORT_DETAIL', 'Report detail must be full or summary');
    requireThat(this.#errors.length === 0, 'RUN_FAILED', 'Run contains rejected invalid input or runtime errors; start a new run with corrected data');
    const initial = BigInt(this.#config.initialCash), ledger = this.#state.ledger;
    const stale = ledger.quantity > 0n && (!this.#mark || this.#lastTime - this.#mark.time > BigInt(this.#config.maxQuoteAgeMs));
    const equity = stale ? null : ledger.cash + ledger.quantity * (this.#mark?.price || 0n);
    const pnl = equity === null ? null : equity - initial;
    const drawdown = this.#drawdown;
    const sources = this.#sources;
    const verification = this.#verification;
    const audit = this.#recording.disk ? this.#recording.seal({config:this.#config,sources,verification}) : null;
    return JSON.parse(json({
      schema: 'bend-backtest-report-v1', status: stale ? 'invalid-terminal-valuation' : 'valid-under-declared-model',
      ledger, reservations: this.#reservations, ...(detail === 'full' ? { orders: this.orders } : {}), recording: { traceMode: this.#options.traceMode },
      ...(audit ? {audit} : {}),
      performance: { initialEquity: initial, terminalEquity: equity, netPnl: pnl,
        totalReturn: pnl === null ? null : { numerator: pnl, denominator: initial },
        maxDrawdownAtQuoteSamples: this.#valuations.length ? drawdown : null,
        fees: this.#fees, sharpe: { value: null, reason: 'No regular sampling frequency or annualization convention specified' } },
      softwareChecks: { bendCompiler: verification.compiler, bendKernel: verification.kernel, runtimeInvariants: 'passed-for-processed-events', proofScope: 'See docs/CONTRACT.md; end-to-end engine properties are tested, not all formally proved' },
      dataQuality: { status: stale ? 'critical-stale-terminal-mark' : 'accepted', acceptedUniqueEvents: this.#events.length, historicalUniverse: [this.#config.instrument.symbol] },
      assumptions: { model: 'cash-spot-fifo-quote-v1', liquidity: 'Each unique tick provides independent bid/ask budgets, replenished only by the next unique tick; no queue position or impact estimation', fees: 'Nonnegative fixed quote minor units per filled lot', price: 'Buys at ask; sells at bid; ordinary limit orders only', timing: 'Fill time >= arrival and > decision; effective cancellation wins ties; report delay zero', valuation: 'Open positions marked at last bid; no hypothetical exit fee; stale terminal marks invalidate performance', capital: 'No leverage, shorting, external cash flows, corporate actions or settlement delay', returns: 'Net P&L / initial cash; open positions included; no external capital accepted', strategy: 'Supplied order decisions are external and not a proof of information availability' },
      manifest: { ...this.#config.manifest, datasetHash: this.#events.hash, configHash: hash(this.#config), sourceHashes: sources, toolchain: verification.toolchain, proofKernelHash: verification.kernelHash, runtime: { node: process.version, platform: process.platform, architecture: process.arch }, stochasticInputs: 'None used by engine' },
      reproducibility: { ledgerReplay: 'Exact replay requires the hashed input events, configuration and source artifacts', strategyResearch: 'Not established: strategyArtifact and evaluationProtocol are supplied identifiers, not independent attestations of external research' },
      ...(detail === 'full' ? {fills:this.#fills.slice(),valuations:this.#valuations.slice(),trace:this.#trace.slice()} : {}),
      traceHash: this.#trace.hash
    }));
  }
}
