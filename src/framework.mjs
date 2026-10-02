import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import Engine from '../build/engine.mjs';

export const MAX_NAT = (1n << 48n) - 1n;
export class BacktestError extends Error {
  constructor(code, message) { super(message); this.name = 'BacktestError'; this.code = code; }
}
export function requireThat(ok, code, message) {
  if (!ok) throw new BacktestError(code, message);
}
export function nat(value, name, positive = false) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'INVALID_INTEGER', `${name} must be a canonical decimal string`);
  const n = BigInt(value);
  requireThat(n <= MAX_NAT && (!positive || n > 0n), 'INTEGER_RANGE', `${name} outside ${positive ? 1 : 0}..2^48-1`);
  return n;
}
export function checked(n, name) {
  requireThat(n >= 0n && n <= MAX_NAT, 'ARITHMETIC_RANGE', `${name} outside 0..2^48-1`);
  return n;
}
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export function canonical(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
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
function verifyState(state, config) {
  const os = orders(state), fee = BigInt(config.feePerLot);
  checked(state.ledger.cash, 'cash'); checked(state.ledger.quantity, 'quantity');
  for (const o of os) {
    requireThat(o.accepted === o.remaining + o.filled + o.cancelled, 'ORDER_ACCOUNTING', 'Order quantities do not reconcile');
    requireThat(o.remaining >= 0n && o.filled >= 0n && o.cancelled >= 0n, 'ORDER_ACCOUNTING', 'Negative order quantity');
  }
  const cashReserved = os.reduce((sum, o) => sum + (o.side.$ === 'Buy' ? o.remaining * (o.limit + fee) : 0n), 0n);
  const quantityReserved = os.reduce((sum, o) => sum + (o.side.$ === 'Sell' ? o.remaining : 0n), 0n);
  requireThat(cashReserved <= state.ledger.cash && quantityReserved <= state.ledger.quantity, 'RESERVATION_BREACH', 'Outstanding reservations exceed capital');
  return { cashReserved, quantityReserved };
}
function sourceManifest() {
  const paths = ['LAWS.bend', 'PROOF.bend', 'scripts/build.mjs', 'build/engine.mjs', 'build/policy.mjs', 'build/archive.mjs', 'toolchain.json', 'package.json',
    ...readdirSync(new URL('../src/', import.meta.url)).filter(name => name.endsWith('.mjs')).map(name => `src/${name}`),
    ...readdirSync(new URL('../bend/', import.meta.url)).filter(name => name.endsWith('.bend')).map(name => `bend/${name}`)].sort();
  return Object.fromEntries(paths.map(path => [path, hash(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))]));
}
// Bind provenance to the implementation loaded by this process, not later disk edits.
const LOADED_SOURCES = freeze(sourceManifest());
export function runtimeProvenance() { return structuredClone(LOADED_SOURCES); }
export class Backtest {
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
  get sources() { return this.#sources; }
  get verification() { return this.#verification; }
  get config() { return this.#config; }
  get state() { return this.#state; }
  get mark() { return this.#mark; }
  get lastTime() { return this.#lastTime; }
  get lastSequence() { return this.#lastSequence; }
  get events() { return Object.freeze(this.#events.slice()); }
  get trace() { return Object.freeze(this.#trace.slice()); }
  get fills() { return Object.freeze(this.#fills.slice()); }
  get valuations() { return Object.freeze(this.#valuations.slice()); }
  get errors() { return Object.freeze(this.#errors.slice()); }
  constructor(config) {
    const verification = JSON.parse(readFileSync(new URL('../build/verification.json', import.meta.url), 'utf8'));
    const current = sourceManifest();
    requireThat(canonical(current) === canonical(LOADED_SOURCES), 'STALE_RUNTIME', 'Source changed after module loading; restart the process');
    requireThat(verification.compiler === 'passed' && verification.sourceHashes && Object.entries(verification.sourceHashes).every(([path, digest]) => current[path] === digest), 'STALE_BUILD', 'Run npm run build: checked source or generated engine differs from build evidence');
    this.#sources = LOADED_SOURCES; this.#verification = freeze(verification);
    this.#config = freeze(validateConfig(config));
    this.#state = freeze(Engine.initial(BigInt(config.initialCash)));
    this.#events = []; this.#trace = []; this.#fills = []; this.#valuations = []; this.#errors = [];
    this.#seen = new Map(); this.#orderIds = new Set(); this.#lastTime = null; this.#lastSequence = null; this.#mark = null;
  }
  step(event) {
    try { return this.#apply(event); }
    catch (error) {
      this.#errors.push(freeze({ eventId: typeof event?.id === 'string' ? event.id : null, code: error.code || 'ERROR', message: String(error.message || error) }));
      throw error;
    }
  }
  #apply(event) {
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
    try {
      if (event.type === 'submit') {
        requireThat(!this.#orderIds.has(event.orderId), 'DUPLICATE_ORDER', 'Order IDs cannot be reused, including rejected orders');
        const arrival = checked(t + BigInt(this.#config.orderLatencyMs), 'arrival');
        const result = Engine.submit(state, BigInt(event.orderId), { $: event.side === 'buy' ? 'Buy' : 'Sell' }, BigInt(event.limit), BigInt(event.quantity), t, arrival, fee);
        state = result.state; status = result.$ === 'Accepted' ? 'accepted' : 'rejected-capital-or-fee';
      } else if (event.type === 'cancel') {
        requireThat(previousOrders.some(o => o.id === BigInt(event.orderId)), 'UNKNOWN_ORDER', 'Cannot cancel an unaccepted order');
        state = Engine.request_cancel(state, BigInt(event.orderId), checked(t + BigInt(this.#config.cancelLatencyMs), 'cancel arrival'));
        state = Engine.advance(state, t);
      } else if (event.type === 'tick') {
        const bid = BigInt(event.bid), ask = BigInt(event.ask);
        state = Engine.tick(state, t, bid, ask, BigInt(event.bidLots), BigInt(event.askLots), fee);
        const after = orders(state);
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
      verifyState(state, this.#config);
      const expected = newFills.reduce((a, f) => ({ cash: a.cash + (f.side === 'buy' ? -f.price * f.quantity : f.price * f.quantity) - f.fee, quantity: a.quantity + (f.side === 'buy' ? f.quantity : -f.quantity) }), { cash: before.cash, quantity: before.quantity });
      requireThat(expected.cash === state.ledger.cash && expected.quantity === state.ledger.quantity, 'LEDGER_MISMATCH', 'Postings disagree with the Bend ledger');
      const equity = mark ? checked(state.ledger.cash + state.ledger.quantity * mark.price, 'equity') : state.ledger.cash;
      // Commit only after all checks pass.
      this.#state = freeze(state); this.#mark = freeze(mark); this.#lastTime = t; this.#lastSequence = seq;
      this.#seen.set(event.id, digest); if (event.type === 'submit') this.#orderIds.add(event.orderId);
      this.#events.push(freeze(structuredClone(event))); this.#fills.push(...freeze(newFills));
      this.#trace.push(freeze({ eventId: event.id, sequence: seq, time: t, status, ledger: state.ledger, orders: orders(state), reservations: verifyState(state, this.#config), fills: newFills.map(f => f.id) }));
      if (event.type === 'tick') this.#valuations.push(freeze({ time: t, equity, cash: state.ledger.cash, quantity: state.ledger.quantity, mark: mark.price }));
      return { duplicate: false, status, fills: structuredClone(newFills) };
    } catch (error) {
      if (error instanceof BacktestError) throw error;
      throw new BacktestError('BEND_RUNTIME', String(error));
    }
  }
  run(events) { for (const event of events) this.step(event); return this; }
  checkpoint() {
    // Event-sourced checkpoint: replay reconstructs reservations, queues, cancellations,
    // deduplication identities, valuations and all other continuation state.
    const body = { format: 'bend-backtest-checkpoint-v1', config: this.#config, events: this.#events, errors: this.#errors, sources: this.#sources };
    return JSON.parse(json({ ...body, checksum: hash(body) }));
  }
  static resume(checkpoint) {
    const { checksum, ...body } = checkpoint;
    requireThat(body.format === 'bend-backtest-checkpoint-v1' && checksum === hash(body), 'CHECKPOINT_CORRUPT', 'Checkpoint format or checksum invalid');
    requireThat(canonical(body.sources) === canonical(sourceManifest()), 'CHECKPOINT_VERSION', 'Checkpoint source artifacts differ from this engine');
    const run = new Backtest(body.config).run(body.events);
    run.#errors = structuredClone(body.errors);
    return run;
  }
  report() {
    requireThat(this.#errors.length === 0, 'RUN_FAILED', 'Run contains rejected invalid input or runtime errors; start a new run with corrected data');
    const initial = BigInt(this.#config.initialCash), ledger = this.#state.ledger;
    const stale = ledger.quantity > 0n && (!this.#mark || this.#lastTime - this.#mark.time > BigInt(this.#config.maxQuoteAgeMs));
    const equity = stale ? null : ledger.cash + ledger.quantity * (this.#mark?.price || 0n);
    const pnl = equity === null ? null : equity - initial;
    let peak = initial, drawdown = { numerator: 0n, denominator: initial };
    for (const v of this.#valuations) {
      if (v.equity > peak) peak = v.equity;
      const loss = peak - v.equity;
      if (loss * drawdown.denominator > drawdown.numerator * peak) drawdown = { numerator: loss, denominator: peak };
    }
    const sources = this.#sources;
    const verification = this.#verification;
    return JSON.parse(json({
      schema: 'bend-backtest-report-v1', status: stale ? 'invalid-terminal-valuation' : 'valid-under-declared-model',
      ledger, reservations: verifyState(this.#state, this.#config), orders: orders(this.#state),
      performance: { initialEquity: initial, terminalEquity: equity, netPnl: pnl,
        totalReturn: pnl === null ? null : { numerator: pnl, denominator: initial },
        maxDrawdownAtQuoteSamples: this.#valuations.length ? drawdown : null,
        fees: this.#fills.reduce((sum, f) => sum + f.fee, 0n), sharpe: { value: null, reason: 'No regular sampling frequency or annualization convention specified' } },
      softwareChecks: { bendCompiler: verification.compiler, bendKernel: verification.kernel, runtimeInvariants: 'passed-for-processed-events', proofScope: 'See docs/CONTRACT.md; end-to-end engine properties are tested, not all formally proved' },
      dataQuality: { status: stale ? 'critical-stale-terminal-mark' : 'accepted', acceptedUniqueEvents: this.#events.length, historicalUniverse: [this.#config.instrument.symbol] },
      assumptions: { model: 'cash-spot-fifo-quote-v1', liquidity: 'Each unique tick provides independent bid/ask budgets, replenished only by the next unique tick; no queue position or impact estimation', fees: 'Nonnegative fixed quote minor units per filled lot', price: 'Buys at ask; sells at bid; ordinary limit orders only', timing: 'Fill time >= arrival and > decision; effective cancellation wins ties; report delay zero', valuation: 'Open positions marked at last bid; no hypothetical exit fee; stale terminal marks invalidate performance', capital: 'No leverage, shorting, external cash flows, corporate actions or settlement delay', returns: 'Net P&L / initial cash; open positions included; no external capital accepted', strategy: 'Supplied order decisions are external and not a proof of information availability' },
      manifest: { ...this.#config.manifest, datasetHash: hash(this.#events), configHash: hash(this.#config), sourceHashes: sources, toolchain: verification.toolchain, proofKernelHash: verification.kernelHash, runtime: { node: process.version, platform: process.platform, architecture: process.arch }, stochasticInputs: 'None used by engine' },
      reproducibility: { ledgerReplay: 'Exact replay requires the hashed input events, configuration and source artifacts', strategyResearch: 'Not established: strategyArtifact and evaluationProtocol are supplied identifiers, not independent attestations of external research' },
      fills: this.#fills, valuations: this.#valuations, trace: this.#trace, traceHash: hash(this.#trace)
    }));
  }
}

// Strategy callback receives a deep-frozen history prefix and current portfolio only.
// The callback's external closures are outside the information-access boundary.
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function runStrategy(config, ticks, onTick) {
  const run = new Backtest(config), history = []; let sequence = 0n, orderId = 0n;
  for (const tick of ticks) {
    requireThat(tick.type === 'tick', 'STRATEGY_INPUT', 'runStrategy accepts ticks only');
    run.step({ ...tick, sequence: String(++sequence) }); history.push(structuredClone(tick));
    const decisions = onTick(freeze({ history: structuredClone(history), ledger: structuredClone(run.state.ledger), orders: structuredClone(orders(run.state)) })) || [];
    requireThat(Array.isArray(decisions), 'STRATEGY_OUTPUT', 'Strategy must return an array of submit/cancel decisions');
    for (const decision of decisions) {
      requireThat(['submit', 'cancel'].includes(decision.type), 'STRATEGY_OUTPUT', 'Only submit/cancel decisions are supported');
      const event = { ...decision, id: `strategy-${++sequence}`, time: tick.time, sequence: String(sequence), symbol: config.instrument.symbol, currency: config.instrument.currency };
      if (decision.type === 'submit') event.orderId = String(++orderId);
      run.step(event);
    }
  }
  return run;
}
