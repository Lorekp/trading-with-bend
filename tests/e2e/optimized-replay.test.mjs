import { replayQuotes as runStrategy } from '../replay-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { Backtest, orders } from '../../src/framework.mjs';
import { MAX_NAT } from '../../src/core.mjs';
import { buyAndHold, movingAverageCrossover, meanReversion, targetPosition } from '../../src/strategies.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, json } from '../../src/core.mjs';
import { readReplayAudit, openReplayAudit } from '../../src/recording.mjs';
import { prepareQuoteData, openQuoteData } from '../../src/quote-data.mjs';
import { quoteInformationSource, InformationSource } from '../../src/information-source.mjs';
import { QuoteExecutionVenue } from '../../src/execution-venue.mjs';
import { runStrategy as replay } from '../../src/replay.mjs';
import { sampleEquity } from '../../src/study.mjs';
import { listExperiments, readExperimentResult, verifyExperiment } from '../../src/experiments.mjs';
import { resolveProtocol, pairSchedule } from '../../experiments/speed/protocol.mjs';
import { summarizeComparison } from '../../experiments/speed/statistics.mjs';
import { runBenchmark } from '../../experiments/speed/benchmark.mjs';

test('default storage keeps historical orders out of matching across 6000 submit/cancel cycles', () => {
  const run = new Backtest({ ...config, cancelLatencyMs: '0' }, { traceMode: 'compact' });
  for (let i = 0; i < 6000; i++) {
    const common = { symbol: config.instrument.symbol, currency: config.instrument.currency, time: String(i * 2), sequence: String(i * 2), orderId: String(i + 1) };
    run.step({ ...common, id: `submit-${i}`, type: 'submit', side: 'buy', quantity: '1', limit: '100' });
    run.step({ ...common, id: `cancel-${i}`, type: 'cancel', time: String(i * 2 + 1), sequence: String(i * 2 + 1) });
    assert.equal(run.workingOrders.length, 0);
  }
  assert.equal(run.orders.length, 6000);
  assert.ok(run.orders.every(order => order.cancelled === 1n));
  assert.deepEqual(run.ledger, { $: 'Ledger', cash: 1000000n, quantity: 0n });
  assert.deepEqual(Backtest.resume(run.checkpoint()).report(), run.report());
});

test('active replay retains a readable immutable public state after thousands of completed orders', () => {
  const run = new Backtest(config, { traceMode: 'compact', orderStorage: 'active' });
  let sequence = 0;
  for (let i = 0; i < 5000; i++) {
    const common = { symbol: config.instrument.symbol, currency: config.instrument.currency };
    run.step({ ...common, id: `submit-large-${i}`, type: 'submit', time: String(i * 2), sequence: String(++sequence), orderId: String(i + 1), side: 'buy', limit: '100', quantity: '1' });
    run.step({ ...common, id: `tick-large-${i}`, type: 'tick', time: String(i * 2 + 1), sourceTime: String(i * 2 + 1), sequence: String(++sequence), bid: '99', ask: '100', bidLots: '1', askLots: '1' });
  }
  assert.equal(run.workingOrders.length, 0);
  const state = run.state, archived = orders(state);
  assert.equal(archived.length, 5000);
  assert.equal(state.ledger.quantity, 5000n);
  assert.equal(state.ledger.cash, 495000n);
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.orders.tail));
  assert.throws(() => { state.orders.tail.head.filled = 0n; }, TypeError);
  assert.deepEqual(Backtest.resume(run.checkpoint()).report(), run.report());
});

const config = {
  instrument: { symbol: 'ETHUSDT', currency: 'USDT', lotSize: '0.001', priceTick: '1' },
  initialCash: '1000000', feePerLot: '1', orderLatencyMs: '1', cancelLatencyMs: '2', maxQuoteAgeMs: '50',
  manifest: { datasetVersion: 'analytic-oscillating-market', strategyArtifact: 'crossover-e2e', evaluationProtocol: 'execution-equivalence', seed: '0' },
};
const ticks = (count = 160) => Array.from({ length: count }, (_, i) => {
  const price = 100 + (i % 24 < 12 ? i % 12 : 12 - i % 12);
  return { id: `quote-${i}`, type: 'tick', sequence: String(i + 1), time: String(i), sourceTime: String(i), symbol: 'ETHUSDT', currency: 'USDT', bid: String(price), ask: String(price + 1), bidLots: '1', askLots: '1' };
});

// Preserve the original cloning adapter as an independent compatibility oracle.
function legacyRunStrategy(configuration, quotes, onTick) {
  const run = new Backtest(configuration, { orderStorage: 'all' }), history = [];
  let sequence = 0n, orderId = 0n;
  const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
  for (const tick of quotes) {
    run.step({ ...tick, sequence: String(++sequence) }); history.push(structuredClone(tick));
    const context = deepFreeze({ history: structuredClone(history), ledger: structuredClone(run.state.ledger), orders: structuredClone(orders(run.state)) });
    const target = onTick(context);
    const decisions = target === null ? [] : referenceTargetOrders(target, configuration.feePerLot, context);
    for (const decision of decisions) {
      const event = { ...decision, id: `strategy-${++sequence}`, time: tick.time, sequence: String(sequence), symbol: configuration.instrument.symbol, currency: configuration.instrument.currency };
      if (decision.type === 'submit') event.orderId = String(++orderId);
      run.step(event);
    }
  }
  return run;
}

// Independent exact-arithmetic oracle: do not use production reconciliation or sizing.
function referenceTargetOrders(target, feePerLot, { ledger, orders, history }) {
  const desired = BigInt(target) < MAX_NAT ? BigInt(target) : MAX_NAT;
  const delta = desired - ledger.quantity, side = delta > 0n ? 'buy' : 'sell';
  const distance = delta < 0n ? -delta : delta, quote = history.at(-1);
  const bid = BigInt(quote.bid), ask = BigInt(quote.ask), fee = BigInt(feePerLot);
  const active = orders.filter(order => order.remaining > 0n);
  const cancel = order => ({ type: 'cancel', orderId: String(order.id) });
  if (active.some(order => order.cancel_at.$ === 'Some')) return active.filter(order => order.cancel_at.$ !== 'Some').map(cancel);
  if (active.length) {
    const remaining = active.reduce((sum, order) => sum + order.remaining, 0n);
    const stale = delta === 0n || remaining > distance || active.some(order =>
      (order.side.$ === 'Buy' ? 'buy' : 'sell') !== side || (side === 'buy' ? order.limit < ask : order.limit > bid));
    return stale ? active.map(cancel) : [];
  }
  const limit = side === 'buy' ? ask : bid;
  if (delta === 0n || (side === 'sell' && limit < fee)) return [];
  const budget = side === 'buy' ? ledger.cash / (limit + fee) : ledger.quantity;
  const headroom = side === 'buy' ? MAX_NAT - ledger.quantity : ledger.quantity;
  const quantity = [distance, budget, headroom].reduce((a, b) => a < b ? a : b);
  return quantity === 0n ? [] : [{ type: 'submit', side, limit: String(limit), quantity: String(quantity) }];
}

test('bounded history preserves a real strategy replay, exact postings, order states, and trace hash', () => {
  const quotes = ticks();
  const strategy = movingAverageCrossover({ fast: 2, slow: 7, quantity: '3' });
  const legacy = legacyRunStrategy(config, quotes, strategy).report();
  const normal = runStrategy(config, quotes, strategy).report();
  const bounded = runStrategy(config, quotes, strategy, { lookback: 8 }).report();
  const active = runStrategy(config, quotes, strategy, { lookback: 8, orderStorage: 'active' }).report();
  assert.ok(legacy.fills.length > 5);
  assert.ok(legacy.fills.some(fill => fill.side === 'buy'));
  assert.ok(legacy.fills.some(fill => fill.side === 'sell'));
  assert.ok(legacy.orders.some(order => BigInt(order.cancelled) > 0n));
  assert.deepEqual(normal, legacy);
  assert.deepEqual(bounded, legacy);
  assert.deepEqual(active, legacy);
  assert.equal(bounded.traceHash, legacy.traceHash);
});

test('bounded contexts expose only the trailing prefix, total tick count, and immutable retained views', () => {
  const quotes = ticks(30).map(tick => ({ ...tick, bid: '99', ask: '100' })), retained = [];
  const strategy = context => {
    retained.push(context);
    assert.equal(context.tickCount, retained.length);
    assert.equal(context.history.length, Math.min(3, context.tickCount));
    assert.equal(context.history[0].id, `quote-${Math.max(0, context.tickCount - 3)}`);
    assert.throws(() => context.history.push(quotes[0]), TypeError);
    assert.throws(() => { context.history[0].bid = '999999'; }, TypeError);
    assert.throws(() => { context.ledger.cash = 0n; }, TypeError);
    for (const order of context.orders) {
      assert.throws(() => { order.side = 'sell'; }, TypeError);
      assert.throws(() => { order.remaining = 999n; }, TypeError);
    }
    if (context.tickCount === 1) return '3';
    return null;
  };
  const run = runStrategy(config, quotes, strategy, { lookback: 3 });
  const firstHistory = retained[0].history.map(quote => ({ ...quote }));
  quotes[0].bid = '999999';
  assert.deepEqual(retained[0].history, firstHistory);
  assert.equal(retained[1].orders[0].remaining, 2n, 'Old order views do not change as later quotes fill the order');
  assert.equal(retained[2].orders[0].remaining, 1n);
  assert.equal(retained.at(-1).orders.length, 0);
  assert.equal(run.state.ledger.quantity, 3n);
  assert.notEqual(retained[1].history, retained[2].history);
  assert.equal(retained[1].history[0], retained[2].history[0], 'Deeply immutable quote objects may be shared safely');
});

test('bounded strategy replay remains exactly resumable from its event-sourced checkpoint', () => {
  const quotes = ticks(70);
  const strategy = movingAverageCrossover({ fast: 2, slow: 7, quantity: '3' });
  const run = runStrategy(config, quotes, strategy, { lookback: 7 });
  const resumed = Backtest.resume(run.checkpoint());
  assert.deepEqual(resumed.report(), run.report());
  const next = { ...ticks(71).at(-1), sequence: String(BigInt(run.lastSequence) + 1n) };
  resumed.step(next); run.step(next);
  assert.deepEqual(resumed.report(), run.report());
});

test('compact recording changes only trace detail and resumes with identical execution history', () => {
  const quotes = ticks(90);
  const strategy = movingAverageCrossover({ fast: 2, slow: 7, quantity: '3' });
  const full = runStrategy(config, quotes, strategy, { lookback: 7 });
  const compact = runStrategy(config, quotes, strategy, { lookback: 7, traceMode: 'compact', orderStorage: 'active' });
  const fullReport = full.report(), compactReport = compact.report();
  const execution = ({ trace, traceHash, recording, ...rest }) => rest;
  assert.deepEqual(execution(compactReport), execution(fullReport));
  assert.deepEqual(compact.events, full.events);
  assert.ok(compactReport.trace.every(event => !Object.hasOwn(event, 'orders')));
  assert.ok(fullReport.trace.every(event => Object.hasOwn(event, 'orders')));
  assert.deepEqual(compactReport.trace, fullReport.trace.map(({ orders, ...event }) => event));
  assert.notEqual(compactReport.traceHash, fullReport.traceHash);
  assert.equal(compactReport.recording.traceMode, 'compact');
  assert.deepEqual(Backtest.resume(compact.checkpoint()).report(), compactReport);
  assert.equal(compact.checkpoint().options.traceMode, 'compact');
  assert.equal(compact.checkpoint().options.orderStorage, 'active');
  assert.throws(() => { compact.options.traceMode = 'full'; }, TypeError);
  assert.throws(() => new Backtest(config, { traceMode: 'none' }), { code: 'TRACE_MODE' });
  assert.throws(() => new Backtest(config, { orderStorage: 'none' }), { code: 'ORDER_STORAGE' });
});

test('history defaults are bounded and full history is an explicit choice', () => {
  for (const lookback of [0, -1, 1.5, Infinity, NaN, null, '3']) {
    assert.throws(() => runStrategy(config, ticks(3), () => assert.fail('Callback must not execute'), { lookback }), { code: 'STRATEGY_LOOKBACK' });
  }
  for (const [lookback, declared, expected] of [[undefined, 3, 3], [undefined, undefined, 256], ['all', 3, 300]]) {
    let count = 0, entries = 0;
    const strategy = ({ history, tickCount }) => {
      count++; entries += history.length;
      assert.equal(history.length, Math.min(count, expected));
      assert.equal(tickCount, count); return null;
    };
    if (declared !== undefined) strategy.lookback = declared;
    runStrategy(config, ticks(300), strategy, { lookback });
    assert.equal(count, 300);
    if (declared === 3 && lookback === undefined) assert.equal(entries, 897);
  }
});

test('active engine storage retains completed-order cancellation metadata, FIFO, and every checkpoint boundary', () => {
  const full = new Backtest(config, { orderStorage: 'all' }), active = new Backtest(config);
  const base = (id, type, time, sequence) => ({ id, type, time: String(time), sequence: String(sequence), symbol: 'ETHUSDT', currency: 'USDT' });
  const events = [
    { ...base('buy', 'submit', 0, 1), orderId: '1', side: 'buy', limit: '100', quantity: '3' },
    { ...base('q1', 'tick', 1, 2), sourceTime: '1', bid: '99', ask: '100', bidLots: '1', askLots: '1' },
    { ...base('cancel', 'cancel', 2, 3), orderId: '1' },
    { ...base('q2', 'tick', 3, 4), sourceTime: '3', bid: '99', ask: '100', bidLots: '1', askLots: '1' },
    { ...base('q3', 'tick', 4, 5), sourceTime: '4', bid: '99', ask: '100', bidLots: '1', askLots: '1' },
    { ...base('closed-cancel', 'cancel', 5, 6), orderId: '1' },
    base('c6', 'clock', 6, 7),
    base('c7', 'clock', 7, 8),
    { ...base('sell', 'submit', 8, 9), orderId: '2', side: 'sell', limit: '105', quantity: '2' },
    { ...base('q4', 'tick', 9, 10), sourceTime: '9', bid: '105', ask: '106', bidLots: '1', askLots: '1' },
    { ...base('closed-before-cancel', 'cancel', 10, 11), orderId: '2' },
    { ...base('q5', 'tick', 11, 12), sourceTime: '11', bid: '106', ask: '107', bidLots: '1', askLots: '1' },
    base('c12', 'clock', 12, 13),
    { ...base('rejected', 'submit', 13, 14), orderId: '3', side: 'sell', limit: '105', quantity: '99' },
  ];
  for (const event of events) {
    assert.deepEqual(active.step(event), full.step(event));
    assert.deepEqual(active.state, full.state);
    assert.deepEqual(active.report(), full.report());
    assert.ok(active.workingOrders.every(order => order.remaining > 0n));
    assert.deepEqual(active.workingOrders, full.workingOrders);
    assert.deepEqual(active.ledger, full.ledger);
    assert.deepEqual(Backtest.resume(active.checkpoint()).report(), Backtest.resume(full.checkpoint()).report());
    assert.equal(active.step(event).duplicate, true);
    assert.equal(full.step(event).duplicate, true);
    if (event.id === 'closed-cancel') {
      assert.equal(active.orders[0].cancel_at.$, 'Some');
      assert.equal(active.workingOrders.length, 0);
    }
    if (event.id === 'c7') assert.equal(active.orders[0].cancel_at.$, 'None');
    if (event.id === 'q5') assert.equal(active.orders[1].cancel_at.$, 'Some');
    if (event.id === 'c12') assert.equal(active.orders[1].cancel_at.$, 'None');
  }
  assert.equal(active.orders.length, 2);
  assert.equal(active.workingOrders.length, 0);
  const before = active.state;
  const unknown = { ...base('unknown-cancel', 'cancel', 14, 15), orderId: '3' };
  assert.throws(() => active.step(unknown), { code: 'UNKNOWN_ORDER' });
  assert.throws(() => full.step(unknown), { code: 'UNKNOWN_ORDER' });
  assert.deepEqual(active.state, before);
  assert.deepEqual(active.state, full.state);
  assert.throws(() => { active.orders[0].remaining = 99n; }, TypeError);
  assert.throws(() => { active.state.orders.head.side.$ = 'Sell'; }, TypeError);
});

test('random partial fills, limits, cancellations, and capital rejection match the all-order reference at every boundary', () => {
  for (let seed = 1; seed <= 3; seed++) {
    let random = seed, nextId = 0;
    const pick = n => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0) % n; };
    const configuration = { ...config, initialCash: '500' };
    const full = new Backtest(configuration, { orderStorage: 'all' }), active = new Backtest(configuration);
    for (let i = 0; i < 45; i++) {
      const event = { id: `${seed}-${i}`, time: String(i), sequence: String(i + 1), symbol: 'ETHUSDT', currency: 'USDT' };
      const kind = pick(4);
      if (kind === 0) Object.assign(event, { type: 'submit', orderId: String(++nextId), side: pick(2) ? 'buy' : 'sell', quantity: String(1 + pick(4)), limit: String(88 + pick(27)) });
      else if (kind === 1 && full.orders.length) Object.assign(event, { type: 'cancel', orderId: String(full.orders[pick(full.orders.length)].id) });
      else {
        const bid = 90 + pick(20);
        Object.assign(event, { type: 'tick', sourceTime: event.time, bid: String(bid), ask: String(bid + 2), bidLots: String(pick(4)), askLots: String(pick(4)) });
      }
      assert.deepEqual(active.step(event), full.step(event), `Seed ${seed}, event ${i}`);
      assert.deepEqual(active.report(), full.report(), `Seed ${seed}, event ${i}`);
      assert.deepEqual(active.state, full.state);
      assert.deepEqual(Backtest.resume(active.checkpoint()).report(), full.report(), `Resumed seed ${seed}, boundary ${i}`);
    }
  }
});

test('failed valuation cannot partially commit an archived cancellation becoming effective', () => {
  const configuration = { ...config, initialCash: String(MAX_NAT), feePerLot: '0' };
  const full = new Backtest(configuration, { orderStorage: 'all' }), active = new Backtest(configuration);
  const base = (id, type, time, sequence) => ({ id, type, time: String(time), sequence: String(sequence), symbol: 'ETHUSDT', currency: 'USDT' });
  const events = [
    { ...base('one-lot', 'submit', 0, 1), orderId: '1', side: 'buy', limit: '1', quantity: '1' },
    { ...base('cheap-fill', 'tick', 1, 2), sourceTime: '1', bid: '1', ask: '1', bidLots: '1', askLots: '1' },
    { ...base('closed-order-cancel', 'cancel', 2, 3), orderId: '1' },
  ];
  full.run(events); active.run(events);
  assert.equal(active.orders[0].remaining, 0n);
  assert.equal(active.orders[0].cancel_at.$, 'Some');
  const priorState = active.state;
  const overflow = { ...base('overflow', 'tick', 4, 4), sourceTime: '4', bid: String(MAX_NAT), ask: String(MAX_NAT), bidLots: '0', askLots: '0' };
  assert.throws(() => active.step(overflow), { code: 'ARITHMETIC_RANGE' });
  assert.throws(() => full.step(overflow), { code: 'ARITHMETIC_RANGE' });
  assert.deepEqual(active.state, priorState);
  assert.deepEqual(active.state, full.state);
  assert.equal(active.orders[0].cancel_at.$, 'Some');
  assert.deepEqual(active.events, full.events);
  assert.deepEqual(Backtest.resume(active.checkpoint()).state, priorState);
});

test('strategy sizing uses the immutable venue fees across independent runs', () => {
  const strategy = buyAndHold({ quantity: '10' });
  const quotes = ticks(4).map(tick => ({ ...tick, bid: '99', ask: '100', askLots: '100' }));
  for (const [feePerLot, quantity, cash] of [['0', '10', '0'], ['5', '9', '55']]) {
    const configuration = { ...config, initialCash: '1000', feePerLot };
    const run = runStrategy(configuration, quotes, context => {
      configuration.feePerLot = '99'; // Caller edits cannot change the running strategy or ledger.
      return strategy(context);
    });
    assert.equal(run.report().ledger.quantity, quantity);
    assert.equal(run.report().ledger.cash, cash);
    assert.ok(run.trace.every(event => event.status !== 'rejected-capital-or-fee'));
  }
  assert.throws(() => buyAndHold({ quantity: '10', feePerLot: '0' }), { code: 'STRATEGY_PARAMETER' });
});

test('declared strategy history rejects insufficient bounds and preserves complete replay', () => {
  for (const strategy of [movingAverageCrossover({ fast: 5, slow: 20, quantity: '3' }),
    meanReversion({ window: 20, quantity: '3' }), targetPosition('3', { maxPositionLots: '3', warmup: 25 })]) {
    assert.throws(() => runStrategy(config, ticks(), strategy, { lookback: strategy.lookback - 1 }), { code: 'STRATEGY_LOOKBACK' });
    const full = runStrategy(config, ticks(), strategy, { lookback: 'all' }).report();
    const automatic = runStrategy(config, ticks(), strategy).report();
    const bounded = runStrategy(config, ticks(), strategy, { lookback: strategy.lookback }).report();
    assert.ok(full.fills.length > 0);
    assert.deepEqual(bounded, full);
    assert.deepEqual(automatic, full);
  }
});

test('quote callbacks retain only working orders while reports and checkpoints retain the complete audit', () => {
  const quotes = ticks(300);
  let callbacks = 0;
  const strategy = context => {
    callbacks++;
    assert.equal(context.orders.length, 0, 'Each preceding one-lot order has already filled');
    return context.ledger.quantity === 0n ? '1' : '0';
  };
  // Constant executable prices make each previous order fill on the next quote.
  for (const quote of quotes) { quote.bid = '100'; quote.ask = '100'; }
  const options = { lookback: 1, traceMode: 'compact' };
  const active = runStrategy(config, quotes, strategy, { ...options, orderStorage: 'active' });
  const reference = runStrategy(config, quotes, strategy, { ...options, orderStorage: 'all' });
  assert.equal(callbacks, quotes.length * 2);
  const report = active.report();
  assert.equal(report.orders.length, quotes.length);
  assert.equal(report.fills.length, quotes.length - 1);
  assert.equal(active.workingOrders.length, 1);
  assert.deepEqual(report, reference.report());
  assert.deepEqual(Backtest.resume(active.checkpoint()).report(), report);
});

const auditDisposers = new WeakMap();
const auditCleanup = (t, dispose) => auditDisposers.get(t).push(dispose);
function auditDirectory(t) {
  const parent = resolve(tmpdir()), directory = mkdtempSync(join(parent, 'bend-replay-audit-'));
  const disposers = []; auditDisposers.set(t, disposers);
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); assert.equal(dirname(directory), parent); rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
const withoutAudit = ({ audit, ...report }) => report;
const plain = value => JSON.parse(json(value));
function auditEvents() {
  const base = (id, type, time) => ({ id, type, time: String(time), sequence: String(time + 1), symbol: 'ETHUSDT', currency: 'USDT' });
  return [
    { ...base('buy', 'submit', 0), orderId: '1', side: 'buy', limit: '100', quantity: '2' },
    { ...base('fill', 'tick', 1), sourceTime: '1', bid: '99', ask: '100', bidLots: '2', askLots: '2' },
    { ...base('cancel-completed', 'cancel', 2), orderId: '1' },
    base('cancel-effective', 'clock', 4),
    { ...base('sell', 'submit', 5), orderId: '2', side: 'sell', limit: '100', quantity: '2' },
    { ...base('partial', 'tick', 6), sourceTime: '6', bid: '100', ask: '101', bidLots: '1', askLots: '1' },
    { ...base('cancel-partial', 'cancel', 7), orderId: '2' },
    { ...base('cancellation-wins', 'tick', 9), sourceTime: '9', bid: '100', ask: '101', bidLots: '1', askLots: '1' },
    { ...base('rejected', 'submit', 10), orderId: '3', side: 'sell', limit: '100', quantity: '99' }
  ];
}

test('disk audit preserves complete exact replay and historical cancellations with bounded summary reporting', t => {
  const root = auditDirectory(t), options = { traceMode: 'compact' }, events = auditEvents();
  const memory = new Backtest(config, options), disk = new Backtest(config, { ...options, auditDirectory: join(root, 'disk') });
  auditCleanup(t, () => disk.abort());
  for (const event of events) {
    assert.deepEqual(disk.step(event), memory.step(event));
    assert.deepEqual(disk.step(event), { duplicate: true });
    assert.deepEqual(disk.ledger, memory.ledger);
  }
  const expected = memory.report(), summary = disk.report();
  for (const key of ['orders', 'fills', 'trace', 'valuations', 'events']) assert.ok(!Object.hasOwn(summary, key));
  assert.equal(summary.dataQuality.acceptedUniqueEvents, events.length);
  assert.equal(summary.traceHash, expected.traceHash);
  assert.equal(summary.manifest.datasetHash, hash(events));
  assert.deepEqual(summary.performance, expected.performance);
  const grid = { startTime: '1', endTime: '9', intervalMs: '4', maxStalenessMs: '4' };
  assert.deepEqual(sampleEquity(summary, grid), sampleEquity(expected, grid));
  for (const name of ['orders', 'fills', 'trace', 'valuations']) assert.deepEqual(plain([...readReplayAudit(summary, name)]), expected[name]);
  assert.deepEqual([...readReplayAudit(summary, 'events')], events);
  assert.deepEqual(withoutAudit(disk.report({ detail: 'full' })), expected);
  assert.deepEqual(summary, disk.report());
  assert.throws(() => disk.step({ ...events.at(-1), id: 'late', orderId: '4', time: '11', sequence: '12' }), { code: 'AUDIT_CLOSED' });
});

test('disk checkpoint is an immutable prefix and resumes into a distinct audit with exact continuation', t => {
  const root = auditDirectory(t), events = auditEvents();
  const original = new Backtest(config, { auditDirectory: join(root, 'original') }); auditCleanup(t, () => original.abort());
  original.run(events.slice(0, 3));
  const checkpoint = original.checkpoint(), bytes = readFileSync(checkpoint.audit.manifestPath);
  const resumed = Backtest.resume(checkpoint, { auditDirectory: join(root, 'resumed') }); auditCleanup(t, () => resumed.abort());
  original.run(events.slice(3)); resumed.run(events.slice(3));
  assert.deepEqual(withoutAudit(original.report({ detail: 'full' })), withoutAudit(resumed.report({ detail: 'full' })));
  assert.deepEqual(readFileSync(checkpoint.audit.manifestPath), bytes);
  assert.deepEqual([...readReplayAudit(checkpoint.audit, 'events')], events.slice(0, 3));
  assert.throws(() => Backtest.resume(checkpoint), { code: 'CHECKPOINT_OPTIONS' });
  assert.throws(() => Backtest.resume(checkpoint, { auditDirectory: join(root, 'original') }), { code: 'EEXIST' });

  // Exercise both committed recording batches and an unfinished tail. Callers
  // may reuse an event object immediately after step() has accepted its value.
  const many = ticks(1307), input = {}, split = 777;
  const longRun = new Backtest(config, { auditDirectory: join(root, 'long-original') }); auditCleanup(t, () => longRun.abort());
  for (const event of many.slice(0, split)) longRun.step(Object.assign(input, event));
  const prefix = longRun.checkpoint(), prefixBytes = readFileSync(prefix.audit.manifestPath);
  const continuation = Backtest.resume(prefix, { auditDirectory: join(root, 'long-resumed') }); auditCleanup(t, () => continuation.abort());
  for (const event of many.slice(split)) { longRun.step(Object.assign(input, event)); continuation.step(event); }
  input.bid = '99999'; input.id = 'changed-after-acceptance';
  const expected = new Backtest(config, { traceMode: 'compact' }).run(many).report();
  assert.deepEqual(withoutAudit(longRun.report({ detail: 'full' })), expected);
  assert.deepEqual(withoutAudit(continuation.report({ detail: 'full' })), expected);
  assert.deepEqual([...readReplayAudit(longRun.report(), 'events')], many);
  assert.deepEqual([...readReplayAudit(prefix.audit, 'events')], many.slice(0, split));
  assert.deepEqual(readFileSync(prefix.audit.manifestPath), prefixBytes);
});

test('a failed buffered audit write poisons the replay and cannot publish a completed manifest', t => {
  const root = auditDirectory(t);
  const originalPrepare = DatabaseSync.prototype.prepare;
  let failWrites = false, failures = 0, run;
  DatabaseSync.prototype.prepare = function (...args) {
    const statement = originalPrepare.apply(this, args), originalRun = statement.run;
    statement.run = function (...values) {
      if (failWrites) { failures++; throw Object.assign(new Error('Audit device write failed'), { code: 'EIO' }); }
      return originalRun.apply(this, values);
    };
    return statement;
  };
  try {
    for (const operation of ['report', 'checkpoint']) {
      const directory = join(root, operation);
      failWrites = false; failures = 0;
      run = new Backtest(config, { auditDirectory: directory }).run(ticks(7));
      const ledger = run.ledger;
      failWrites = true;
      assert.throws(() => run[operation](), { code: 'EIO' });
      assert.equal(failures, 1);
      assert.deepEqual(run.ledger, ledger);
      assert.throws(() => run.report(), { code: 'AUDIT_FAILED' });
      assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.json')), []);
      assert.throws(() => openReplayAudit(join(directory, 'manifest.json')), { code: 'ENOENT' });
      run.abort();
    }
  } finally { DatabaseSync.prototype.prepare = originalPrepare; run?.abort(); }
});

test('disk failures preserve ID rules and never publish incomplete or corrupt audits', t => {
  const root = auditDirectory(t), events = auditEvents();
  for (const [name, event, code] of [
    ['collision', { ...events[0], quantity: '3' }, 'EVENT_ID_COLLISION'],
    ['reuse-rejected', { ...events.at(-1), id: 'second-submit', time: '11', sequence: '12' }, 'DUPLICATE_ORDER']
  ]) {
    const directory = join(root, name), run = new Backtest(config, { auditDirectory: directory }); auditCleanup(t, () => run.abort());
    run.run(events); const before = run.ledger;
    assert.throws(() => run.step(event), { code }); assert.deepEqual(run.ledger, before);
    assert.throws(() => run.report(), { code: 'AUDIT_FAILED' });
    assert.ok(!existsSync(join(directory, 'manifest.json')));
    assert.throws(() => openReplayAudit(join(directory, 'manifest.json')), { code: 'ENOENT' });
  }
  const directory = join(root, 'publish-failure'), run = new Backtest(config, { auditDirectory: directory }); auditCleanup(t, () => run.abort());
  run.run(events); writeFileSync(join(directory, 'manifest.json'), 'occupied', { flag: 'wx' });
  assert.throws(() => run.report(), { code: 'EEXIST' });
  assert.throws(() => run.report(), { code: 'AUDIT_FAILED' });
  assert.throws(() => openReplayAudit(join(directory, 'manifest.json')));
  const good = new Backtest(config, { auditDirectory: join(root, 'corrupt') }).run(events).report();
  const file = join(dirname(good.audit.manifestPath), good.audit.file), data = readFileSync(file);
  data[data.length - 1] ^= 1; writeFileSync(file, data);
  assert.throws(() => [...readReplayAudit(good, 'events')], { code: 'AUDIT_CORRUPT' });
});

test('a durability failure after writing manifest bytes cannot publish an audit or checkpoint', t => {
  const root = auditDirectory(t), events = auditEvents();
  for (const operation of ['report', 'checkpoint']) {
    const directory = join(root, operation), run = new Backtest(config, { auditDirectory: directory }).run(events);
    auditCleanup(t, () => run.abort());
    const original = fs.writeFileSync;
    let injected = 0;
    fs.writeFileSync = (path, ...args) => {
      const result = original(path, ...args);
      if (dirname(String(path)) === directory && String(path).includes('.json')) {
        injected++;
        throw Object.assign(new Error('Durability failure after manifest bytes were written'), { code: 'EIO' });
      }
      return result;
    };
    syncBuiltinESMExports();
    try { assert.throws(() => run[operation](), { code: 'EIO' }); }
    finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
    assert.equal(injected, 1);
    assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.json')), [], 'Only incomplete files may survive failed publication');
    assert.throws(() => openReplayAudit(join(directory, 'manifest.json')), { code: 'ENOENT' });
    if (operation === 'report') assert.throws(() => run.report(), { code: 'AUDIT_FAILED' });
    else {
      const saved = run.checkpoint();
      assert.deepEqual([...readReplayAudit(saved.audit, 'events')], events);
    }
  }
});

test('prepared data, disk replay and checkpoint restore support paths longer than Windows MAX_PATH', async t => {
  const root = auditDirectory(t), longRoot = join(root, `experiment-${'a'.repeat(70)}`, `attempt-${'b'.repeat(70)}`, `artifact-${'c'.repeat(70)}`);
  assert.ok(longRoot.length > 260);
  const quotes = ticks(8).map(quote => ({ ...quote, bid: '99', ask: '100' }));
  const dataset = await prepareQuoteData(quotes, { instrument: config.instrument, directory: join(longRoot, 'quotes') });
  auditCleanup(t, () => dataset.close());
  const venue = new QuoteExecutionVenue({ id: 'long-path-venue', config, ticks: dataset, maxPositionLots: '1', auditDirectory: join(longRoot, 'replay') });
  auditCleanup(t, () => venue.abort());
  const result = replay(quoteInformationSource({ id: 'long-path-source', instrument: config.instrument, ticks: dataset }), venue, targetPosition('1'));
  const checkpoint = venue.backtest.checkpoint();
  const restored = Backtest.resume(checkpoint, { auditDirectory: join(longRoot, 'restored') });
  auditCleanup(t, () => restored.abort());
  const report = result.report();
  assert.ok(report.audit.manifestPath.length > 260);
  assert.ok([...readReplayAudit(report, 'fills')].length > 0);
  assert.deepEqual(withoutAudit(restored.report({ detail: 'full' })), withoutAudit(venue.backtest.report({ detail: 'full' })));
  const reopened = openQuoteData(dataset.manifest.audit.manifestPath);
  try { assert.deepEqual([...reopened.rows()], quotes); } finally { reopened.close(); }
});

test('empty quote preparation validates instrument units before creating an artifact', async t => {
  const root = auditDirectory(t);
  for (const [name, instrument] of [['missing', undefined], ['zero-lot', { ...config.instrument, lotSize: '0' }]]) {
    const directory = join(root, name);
    await assert.rejects(prepareQuoteData([], { instrument, directory }), { code: 'DATA_INSTRUMENT' });
    assert.equal(existsSync(directory), false);
  }
  const valid = await prepareQuoteData([], { instrument: config.instrument, directory: join(root, 'valid-empty') });
  try { assert.deepEqual([...valid.rows()], []); assert.equal(valid.manifest.datasetHash, hash([])); }
  finally { valid.close(); }
});

test('admitted quotes supply independent reusable cursors and reserve future market IDs exactly', async t => {
  const root = auditDirectory(t), quotes = ticks(1307);
  quotes[2].id = 'strategy-2'; quotes[3].id = 'strategy-2-'; quotes[4].id = 'venue-clock-3';
  const dataset = await prepareQuoteData((async function* () {
    const input = {};
    for (const quote of quotes) yield Object.assign(input, quote);
    input.id = 'changed-after-admission'; input.bid = '99999';
  })(), { instrument: config.instrument, directory: join(root, 'data') });
  auditCleanup(t, () => dataset.close());
  const informationSource = quoteInformationSource({ id: 'shared-source', instrument: config.instrument, ticks: dataset });
  const execute = input => replay(quoteInformationSource({ id: 'shared-source', instrument: config.instrument, ticks: input }),
    new QuoteExecutionVenue({ id: 'shared-venue', config, ticks: input, maxPositionLots: '2', traceMode: 'compact' }), targetPosition('2'));
  const memory = execute(quotes), first = execute(dataset), second = execute(dataset);
  assert.deepEqual(first.report(), memory.report()); assert.deepEqual(second.report(), memory.report());
  assert.equal(first.targetsHash, hash(quotes.map(row => ({ time: row.time, target: '2' }))));
  const a = informationSource.observations(), b = informationSource.observations();
  assert.equal(a.next().value.data.id, quotes[0].id); assert.equal(a.next().value.data.id, quotes[1].id);
  assert.equal(b.next().value.data.id, quotes[0].id); a.return(); b.return();
  const lead = dataset.rows(), lag = dataset.rows();
  assert.deepEqual(lag.next().value, quotes[0]);
  for (const quote of quotes) assert.deepEqual(lead.next().value, quote);
  assert.equal(lead.next().done, true);
  for (const quote of quotes.slice(1)) {
    const row = lag.next().value;
    assert.deepEqual(row, quote);
    assert.throws(() => { row.bid = '99999'; }, TypeError);
  }
  assert.equal(lag.next().done, true, 'A lagging cursor completes after another cursor crosses every chunk');
  const venue = new QuoteExecutionVenue({ id: 'clock-venue', config, ticks: dataset, maxPositionLots: '2', auditDirectory: join(root, 'clock-replay') });
  auditCleanup(t, () => venue.abort());
  const source = new InformationSource({ id: 'clock-source', instrument: config.instrument,
    observations: [0, 7, 8].map(time => ({ time: String(time), availableAt: String(time), data: { time: String(time) } })) });
  const report = replay(source, venue, targetPosition('2')).report();
  const events = [...readReplayAudit(report, 'events')];
  assert.ok(events.some(event => event.type === 'submit' && event.id === 'strategy-2--'));
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
  assert.throws(() => quoteInformationSource({ id: 'bad-units', instrument: { ...config.instrument, lotSize: '1' }, ticks: dataset }), { code: 'UNIT_MISMATCH' });
  const reopened = openQuoteData(dataset.manifest.audit); assert.deepEqual([...reopened.rows()], quotes); reopened.close();
});

test('upstream iterator failures invalidate partial replay and failed data admission leaves no manifest', async t => {
  const root = auditDirectory(t), quotes = ticks(3);
  for (const disk of [false, true]) {
    const run = new Backtest(config, disk ? { auditDirectory: join(root, 'input-error') } : {}); auditCleanup(t, () => run.abort());
    const source = (function* () { yield quotes[0]; throw new Error('read failure'); })();
    assert.throws(() => run.run(source), /read failure/);
    assert.throws(() => run.report(), /failed|error|aborted/i);
  }
  const venue = new QuoteExecutionVenue({ id: 'read-failure', config, ticks: quotes, maxPositionLots: '1', auditDirectory: join(root, 'strategy-error') });
  auditCleanup(t, () => venue.abort());
  const source = { instrument: config.instrument, manifest: { id: 'failing-source' },
    *observations() { yield { time: '0', availableAt: '0', data: quotes[0] }; throw new Error('information read failure'); } };
  assert.throws(() => replay(source, venue, targetPosition('1')), /information read failure/);
  assert.throws(() => venue.backtest.report(), { code: 'AUDIT_FAILED' });
  const directory = join(root, 'admission-error');
  await assert.rejects(prepareQuoteData((async function* () { yield quotes[0]; throw new Error('download interrupted'); })(), { instrument: config.instrument, directory }), /download interrupted/);
  assert.ok(!existsSync(join(directory, 'manifest.json')));
});

test('large disk replay returns bounded summary while every audit record remains iterable', async t => {
  const root = auditDirectory(t), count = 6000;
  const quotes = (function* () { for (let index = 0; index < count; index++) yield { ...ticks(1)[0], id: `large-${index}`, time: String(index), sourceTime: String(index), sequence: String(index + 1), bid: '100', ask: '100' }; })();
  const dataset = await prepareQuoteData(quotes, { instrument: config.instrument, directory: join(root, 'large-data') }); auditCleanup(t, () => dataset.close());
  const venue = new QuoteExecutionVenue({ id: 'large-venue', config, ticks: dataset, maxPositionLots: '1', auditDirectory: join(root, 'large-replay') }); auditCleanup(t, () => venue.abort());
  const report = replay(quoteInformationSource({ id: 'large-information', instrument: config.instrument, ticks: dataset }), venue,
    targetPosition(({ ledger }) => ledger.quantity === 0n ? '1' : '0')).report();
  assert.ok(JSON.stringify(report).length < 30000);
  assert.equal(report.audit.streams.fills.count, count - 1);
  assert.equal(report.audit.streams.orders.count, count);
  assert.ok(!Object.hasOwn(report, 'orders') && !Object.hasOwn(report, 'trace') && !Object.hasOwn(report, 'valuations'));
  let seen = 0; for (const fill of readReplayAudit(report, 'fills')) { assert.equal(fill.quantity, 1n); seen++; }
  assert.equal(seen, count - 1);
});

test('five campaign workers reuse one admitted dataset and match independent memory replays under a heap limit', { timeout: 120000 }, async t => {
  const root = auditDirectory(t), count = 1307, orderEvery = 32;
  const instrument = { symbol: 'BENCH', currency: 'USDT', lotSize: '0.001', priceTick: '1' };
  const quotes = Array.from({ length: count }, (_, index) => ({
    id: `tick-${index}`, type: 'tick', sequence: String(index + 1), time: String(index), sourceTime: String(index),
    symbol: instrument.symbol, currency: instrument.currency, bid: '9999', ask: '10000', bidLots: '100', askLots: '100'
  }));
  const data = await prepareQuoteData(quotes, { instrument, directory: join(root, 'shared-data') });
  const datasetHash = data.manifest.datasetHash, manifestPath = data.manifest.audit.manifestPath;
  data.close();
  const admittedBytes = readFileSync(manifestPath), campaign = join(root, 'campaign');
  const result = spawnSync(process.execPath, ['scripts/benchmark-campaign.mjs', '--output', campaign,
    '--dataset', manifestPath, '--ticks', String(count), '--workers', '5', '--order-every', String(orderEvery)], {
    encoding: 'utf8', timeout: 90000, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=128` }
  });
  assert.ifError(result.error); assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(readFileSync(join(campaign, 'summary.json'), 'utf8'));
  assert.equal(summary.workers, 5); assert.equal(summary.count, count);
  assert.equal(summary.results.length, 5);
  assert.ok(summary.results.every(row => row.status === 'completed'), JSON.stringify(summary.results));
  assert.deepEqual(readFileSync(manifestPath), admittedBytes);
  assert.equal(existsSync(join(campaign, 'data')), false, 'Workers reuse the supplied admitted data');
  const registry = join(campaign, 'registry'), jobs = listExperiments(registry), audits = new Set();
  assert.equal(jobs.length, 5);
  assert.deepEqual(new Set(jobs.map(job => job.configuration.manifestPath)), new Set([manifestPath]));
  assert.equal(new Set(jobs.map(job => job.attempts.at(-1).workerPid)).size, 5);
  for (const job of jobs) {
    assert.equal(job.status, 'completed'); assert.equal(job.attempts.length, 1);
    const actual = readExperimentResult(registry, job.key), index = job.configuration.index;
    const configuration = { instrument, initialCash: '100000000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '60000',
      manifest: { datasetVersion: datasetHash, strategyArtifact: 'scaling-roundtrip', evaluationProtocol: 'capacity-only', seed: String(index) } };
    const venue = new QuoteExecutionVenue({ id: 'scaling-venue', config: configuration, ticks: quotes, maxPositionLots: '1', traceMode: 'compact' });
    const expected = replay(quoteInformationSource({ id: 'scaling-source', instrument, ticks: quotes }), venue,
      ({ index: row, ledger }) => row < count - 1 && row % orderEvery === index % orderEvery ? (ledger.quantity === 0n ? '1' : '0') : null,
      { lookback: 256 }).report();
    assert.equal(actual.traceHash, expected.traceHash, job.key);
    assert.deepEqual(actual.ledger, expected.ledger, job.key);
    assert.equal(actual.fills, expected.fills.length); assert.ok(actual.fills > 30);
    const report = JSON.parse(readFileSync(join(job.attempts[0].outputDirectory, 'report.json'), 'utf8'));
    assert.equal(report.trace, undefined);
    assert.equal(report.routing.informationSource.datasetHash, datasetHash);
    assert.equal(report.audit.streams.trace.count, expected.trace.length);
    assert.deepEqual(plain([...readReplayAudit(report, 'fills')]), expected.fills);
    audits.add(report.audit.manifestPath);
  }
  assert.equal(audits.size, 5, 'Every worker owns its complete audit');
});

test('speed benchmark bootstraps whole pairs and withholds incomplete or diagnostic conclusions', () => {
  const protocol = resolveProtocol({ schema: 'speed-benchmark-v1', suite: 'quote-replay-v1', profile: 'release',
    datasetSeed: 1, scheduleSeed: 12345, analysisSeed: 67890 });
  const samples = [];
  const schedule = pairSchedule(protocol);
  for (const caseId of protocol.cases) for (let pair = 0; pair < protocol.pairs; pair++) {
    // Strong pair-level variation must cancel in a constant paired ratio.
    const duration = 2 ** (pair % 10);
    for (const target of schedule.find(row => row.caseId === caseId && row.pair === pair).order) samples.push({ caseId, pair, target, stage: 'measurement',
      status: 'completed', evidenceHash: hash('same-evidence'), jobWallMs: duration * (target === 'candidate' ? 0.8 : 1) });
  }
  const summary = summarizeComparison(protocol, samples);
  for (const row of summary) {
    assert.equal(row.completedPairs, protocol.pairs);
    assert.equal(row.conclusion, 'improvement');
    assert.ok(Math.abs(row.timeRatio - 0.8) < 1e-12);
    assert.ok(row.timeRatio95PercentInterval.every(value => Math.abs(value - 0.8) < 1e-12));
  }
  const failed = structuredClone(samples); failed[0].status = 'failed';
  const incomplete = summarizeComparison(protocol, failed)[0];
  assert.equal(incomplete.completedPairs, protocol.pairs - 1);
  assert.equal(incomplete.conclusion, 'incomplete');
  assert.equal(incomplete.eligibleForInference, false);
  const mismatched = structuredClone(samples); mismatched[0].evidenceHash = hash('different');
  assert.equal(summarizeComparison(protocol, mismatched)[0].conclusion, 'incomplete');
  for (const [ratio, conclusion] of [[1, 'within-tolerance'], [1.2, 'regression']]) {
    const changed = samples.map(row => ({ ...row, jobWallMs: row.target === 'candidate' ? row.jobWallMs / 0.8 * ratio : row.jobWallMs }));
    assert.ok(summarizeComparison(protocol, changed).every(row => row.conclusion === conclusion));
  }
  assert.throws(() => summarizeComparison(protocol, [...samples, samples[0]]), { code: 'BENCHMARK_SAMPLES' });
  for (const profile of ['smoke', 'pilot']) {
    const diagnostic = resolveProtocol({ schema: 'speed-benchmark-v1', suite: 'quote-replay-v1', profile,
      datasetSeed: 1, scheduleSeed: 12345, analysisSeed: 67890 });
    const rows = summarizeComparison(diagnostic, samples.filter(row => row.pair < diagnostic.pairs));
    assert.ok(rows.every(row => !row.eligibleForInference && row.conclusion === `${profile}-only`));
  }
});

test('speed benchmark freezes calibrated protocols and screens order effects and drift', () => {
  const input = { schema: 'speed-benchmark-v1', suite: 'quote-replay-v1', profile: 'release',
    datasetSeed: 1, scheduleSeed: 12345, analysisSeed: 67890, pairs: 60, timeoutMs: 600000 };
  const calibrated = resolveProtocol(input);
  assert.equal(calibrated.pairs, 60); assert.equal(calibrated.timeoutMs, 600000);
  assert.deepEqual(resolveProtocol(JSON.parse(JSON.stringify(calibrated))), calibrated);
  assert.throws(() => resolveProtocol({ ...calibrated, lookback: 1 }), { code: 'BENCHMARK_PROTOCOL' });
  assert.throws(() => resolveProtocol({ ...calibrated, extra: true }), { code: 'BENCHMARK_PROTOCOL' });
  for (const invalid of [{ pairs: 1 }, { pairs: 1.5 }, { timeoutMs: 9999 }]) {
    assert.throws(() => resolveProtocol({ ...input, ...invalid }), { code: 'BENCHMARK_BUDGET' });
  }
  const protocol = resolveProtocol({ ...input, pairs: 20 });
  const schedule = pairSchedule(protocol);
  const makeRows = timing => schedule.flatMap(({ caseId, pair, order }, index) => order.map((target, position) => ({
    caseId, pair, target, stage: 'measurement', status: 'completed', evidenceHash: hash('same'),
    jobWallMs: timing({ index, target, order, position }),
  })));
  // Identical versions: the second member always takes half as long. AB happens in a slower regime.
  const confounded = makeRows(({ order, position }) => (order[0] === 'baseline' ? 200 : 20) * (position ? 0.5 : 1));
  for (const row of summarizeComparison(protocol, confounded)) {
    assert.ok(row.timeRatio95PercentInterval[1] < 0.95);
    assert.equal(row.conclusion, 'requires-review'); assert.equal(row.eligibleForInference, false);
    assert.ok(row.diagnostics.issues.includes('order-effect'));
    assert.equal(row.diagnostics.orderGroups.AB.timeRatio, 0.5);
    assert.equal(row.diagnostics.orderGroups.BA.timeRatio, 2);
  }
  const drift = makeRows(({ index, target }) => (index < schedule.length / 2 ? 100 : 200) * (target === 'candidate' ? 0.8 : 1));
  for (const row of summarizeComparison(protocol, drift)) {
    assert.equal(row.conclusion, 'requires-review'); assert.equal(row.eligibleForInference, false);
    assert.ok(row.diagnostics.issues.includes('baseline-drift'));
    assert.ok(row.diagnostics.issues.includes('candidate-drift'));
  }
  const stable = makeRows(({ target }) => target === 'candidate' ? 80 : 100);
  assert.ok(summarizeComparison(protocol, stable).every(row => row.conclusion === 'improvement' && row.diagnostics.status === 'passed'));
});

test('speed benchmark rejects matching target harnesses that differ from the controller', async t => {
  const root = auditDirectory(t), target = join(root, 'target'), output = join(root, 'comparison');
  cpSync(resolve('experiments/speed'), join(target, 'experiments/speed'), { recursive: true });
  const worker = join(target, 'experiments/speed/worker.mjs');
  writeFileSync(worker, readFileSync(worker, 'utf8').replace('strategy, { lookback })', 'strategy, { lookback: 1 })'));
  await assert.rejects(runBenchmark({ schema: 'speed-benchmark-v1', suite: 'quote-replay-v1', profile: 'smoke',
    datasetSeed: 1, scheduleSeed: 12345, analysisSeed: 67890 },
  { baselineRoot: target, candidateRoot: target, outputDirectory: output }), { code: 'BENCHMARK_HARNESS' });
  assert.equal(existsSync(output), false, 'Reject a different workload before creating attempts');
});

test('speed benchmark runs isolated A/A pairs with complete evidence and records a real worker failure', { timeout: 120000 }, t => {
  const root = auditDirectory(t), output = join(root, 'speed');
  const execute = args => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 90000, windowsHide: true });
  const run = execute(['scripts/benchmark.mjs', '--profile', 'smoke', '--output', output]);
  assert.ifError(run.error); assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  const report = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  const samples = JSON.parse(readFileSync(join(output, 'samples.json'), 'utf8'));
  assert.equal(report.status, 'completed'); assert.equal(report.comparisonType, 'A/A');
  assert.ok(report.comparisons.every(row => row.completedPairs === 2 && row.conclusion === 'smoke-only' && !row.eligibleForInference));
  const measured = samples.filter(row => row.stage === 'measurement');
  assert.equal(measured.length, 8);
  assert.equal(new Set(samples.map(row => row.workerPid)).size, samples.length);
  assert.equal(new Set(samples.map(row => row.registry)).size, samples.length);
  for (const row of samples) {
    assert.equal(row.status, 'completed'); assert.equal(row.seed, 1);
    assert.ok(row.buys > 0 && row.sells > 0);
    assert.equal(row.metrics.observationCount, 1024);
    assert.equal(row.metrics.runtime.nodeOptions, '--max-old-space-size=256');
    assert.equal(row.metrics.workload.lookback, 256);
    assert.equal(row.metrics.workload.traceMode, 'compact');
    assert.equal(row.metrics.workload.orderStorage, 'active');
    assert.deepEqual(row.metrics.runtime.execArgv, []);
    assert.ok(row.metrics.runtime.heapLimitBytes >= 256 * 1048576);
    assert.equal(readExperimentResult(row.registry, row.key).traceHash, row.metrics.traceHash);
  }
  assert.ok(measured.some(row => !Number.isInteger(row.jobWallMs)), 'Raw timings retain fractional milliseconds');
  const savedProtocol = JSON.parse(readFileSync(join(output, 'protocol.json'), 'utf8'));
  assert.deepEqual(resolveProtocol(savedProtocol), savedProtocol);
  const rerun = execute(['scripts/benchmark.mjs', '--protocol', join(output, 'protocol.json'), '--output', join(root, 'rerun')]);
  assert.ifError(rerun.error); assert.equal(rerun.status, 0, `${rerun.stderr}\n${rerun.stdout}`);
  const protocol = JSON.parse(readFileSync(join(output, 'run.json'), 'utf8'));
  assert.deepEqual(protocol.harnesses.baseline, protocol.harnesses.controller);
  assert.deepEqual(protocol.harnesses.candidate, protocol.harnesses.controller);
  assert.deepEqual(protocol.schedule, pairSchedule(protocol));
  const observedOrder = measured.map(({ caseId, pair, target }) => ({ caseId, pair, target }));
  assert.deepEqual(observedOrder, protocol.schedule.flatMap(({ caseId, pair, order }) => order.map(target => ({ caseId, pair, target }))));
  for (const caseId of protocol.cases) for (let pair = 0; pair < 2; pair++) {
    const members = measured.filter(row => row.caseId === caseId && row.pair === pair);
    assert.equal(members[0].evidenceHash, members[1].evidenceHash);
    assert.equal(members[0].inputHash, members[1].inputHash);
  }
  // A changed dependency cannot silently turn into another admissible trial.
  const dependency = protocol.datasets[protocol.cases[0]].manifestPath, bytes = readFileSync(dependency);
  writeFileSync(dependency, Buffer.concat([bytes, Buffer.from(' ')]));
  assert.throws(() => verifyExperiment(listExperiments(measured.find(row => row.caseId === protocol.cases[0]).registry)[0]), { code: 'DEPENDENCY_CHANGED' });
  writeFileSync(dependency, bytes);

  // Profiling reuses exact saved work in a separate registry, never timing samples.
  const selected = measured[0], profilingRegistry = join(root, 'profiling-registry');
  const timingBytes = readFileSync(join(output, 'samples.json'));
  const profiling = execute(['experiments/hillclimb/profile.mjs',
    join(output, 'attempts/measurement', selected.caseId, String(selected.pair), selected.target, 'execution/request.json'), profilingRegistry]);
  assert.ifError(profiling.error); assert.equal(profiling.status, 0, `${profiling.stderr}\n${profiling.stdout}`);
  const profiled = JSON.parse(profiling.stdout).result;
  assert.equal(profiled.eligibleForTimingInference, false);
  assert.equal(profiled.traceHash, selected.metrics.traceHash);
  assert.equal(profiled.targetsHash, selected.metrics.targetsHash);
  assert.deepEqual(profiled.counts, selected.metrics.counts);
  assert.equal(profiled.runtime.nodeOptions, '--max-old-space-size=256');
  const profilingJob = listExperiments(profilingRegistry)[0];
  const cpuProfile = JSON.parse(readFileSync(join(profilingJob.attempts[0].outputDirectory, 'profile.cpuprofile'), 'utf8'));
  assert.ok(cpuProfile.nodes.length > 0 && cpuProfile.samples.length > 0);
  assert.deepEqual(readFileSync(join(output, 'samples.json')), timingBytes);

  const requestPath = join(root, 'failure-request.json'), registry = join(root, 'failure-registry');
  const data = protocol.datasets[protocol.cases[0]];
  writeFileSync(requestPath, JSON.stringify({ action: 'run', responsePath: join(root, 'failure-response.json'), registry,
    key: 'speed/failing-input', protocolPath: join(output, 'protocol.json'), timeoutMs: 10000,
    configuration: { manifestPath: data.manifestPath, inputHash: hash('wrong-input'), count: 1024,
      caseId: protocol.cases[0], seed: 1, orderEvery: 32, lookback: 256 } }));
  const failure = execute(['experiments/speed/runner.mjs', requestPath]);
  assert.ifError(failure.error); assert.equal(failure.status, 1);
  const jobs = listExperiments(registry);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'failed');
  assert.equal(jobs[0].attempts[0].error.code, 'BENCHMARK_INPUT');
  assert.equal(existsSync(join(jobs[0].attempts[0].outputDirectory, 'report.json')), false);
});
