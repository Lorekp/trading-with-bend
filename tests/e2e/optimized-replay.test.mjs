import test from 'node:test';
import assert from 'node:assert/strict';
import { Backtest, orders, runStrategy } from '../../src/framework.mjs';
import { MAX_NAT } from '../../src/core.mjs';
import { buyAndHold, movingAverageCrossover, meanReversion, targetPosition } from '../../src/strategies.mjs';

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
    const decisions = onTick(deepFreeze({ config: structuredClone(configuration), history: structuredClone(history), ledger: structuredClone(run.state.ledger), orders: structuredClone(orders(run.state)) })) || [];
    for (const decision of decisions) {
      const event = { ...decision, id: `strategy-${++sequence}`, time: tick.time, sequence: String(sequence), symbol: configuration.instrument.symbol, currency: configuration.instrument.currency };
      if (decision.type === 'submit') event.orderId = String(++orderId);
      run.step(event);
    }
  }
  return run;
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
  const quotes = ticks(30), retained = [];
  const strategy = context => {
    retained.push(context);
    assert.equal(context.tickCount, retained.length);
    assert.equal(context.history.length, Math.min(3, context.tickCount));
    assert.equal(context.history[0].id, `quote-${Math.max(0, context.tickCount - 3)}`);
    assert.throws(() => context.history.push(quotes[0]), TypeError);
    assert.throws(() => { context.history[0].bid = '999999'; }, TypeError);
    assert.throws(() => { context.ledger.cash = 0n; }, TypeError);
    for (const order of context.orders) {
      assert.throws(() => { order.side.$ = 'Sell'; }, TypeError);
      assert.throws(() => { order.remaining = 999n; }, TypeError);
    }
    if (context.tickCount === 1) return [{ type: 'submit', side: 'buy', limit: '999', quantity: '3' }];
    return [];
  };
  const run = runStrategy(config, quotes, strategy, { lookback: 3 });
  const firstHistory = retained[0].history.map(quote => ({ ...quote }));
  quotes[0].bid = '999999';
  assert.deepEqual(retained[0].history, firstHistory);
  assert.equal(retained[1].orders[0].remaining, 2n, 'Old order views do not change as later quotes fill the order');
  assert.equal(retained[2].orders[0].remaining, 1n);
  assert.deepEqual(retained.at(-1).orders, []);
  assert.equal(run.orders[0].remaining, 0n);
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

test('invalid history bounds fail before any strategy callback; default still receives complete history', () => {
  for (const lookback of [0, -1, 1.5, Infinity, NaN, null, '3']) {
    assert.throws(() => runStrategy(config, ticks(3), () => assert.fail('Callback must not execute'), { lookback }), { code: 'STRATEGY_LOOKBACK' });
  }
  let count = 0;
  runStrategy(config, ticks(5), ({ history, tickCount }) => { count++; assert.equal(history.length, count); assert.equal(tickCount, count); return []; });
  assert.equal(count, 5);
});

test('strategy sizing uses the immutable replay fees across independent runs', () => {
  const strategy = buyAndHold({ quantity: '10' });
  const quotes = ticks(4).map(tick => ({ ...tick, bid: '99', ask: '100', askLots: '100' }));
  for (const [feePerLot, quantity, cash] of [['0', '10', '0'], ['5', '9', '55']]) {
    const configuration = { ...config, initialCash: '1000', feePerLot };
    const run = runStrategy(configuration, quotes, context => {
      assert.ok(Object.isFrozen(context.config) && Object.isFrozen(context.config.instrument));
      assert.throws(() => { context.config.feePerLot = '0'; }, TypeError);
      configuration.feePerLot = '99'; // Caller edits cannot change the running strategy or ledger.
      return strategy(context);
    });
    assert.equal(run.report().ledger.quantity, quantity);
    assert.equal(run.report().ledger.cash, cash);
    assert.ok(run.trace.every(event => event.status !== 'rejected-capital-or-fee'));
  }
  assert.throws(() => buyAndHold({ quantity: '10', feePerLot: '0' }), { code: 'STRATEGY_PARAMETER' });
});

test('declared strategy history is checked before consuming input and preserves complete replay', () => {
  for (const strategy of [movingAverageCrossover({ fast: 5, slow: 20, quantity: '3' }),
    meanReversion({ window: 20, quantity: '3' }), targetPosition('3', { maxPositionLots: '3', warmup: 25 })]) {
    function* unread() { assert.fail('Insufficient history must fail before reading a quote'); }
    assert.throws(() => runStrategy(config, unread(), strategy, { lookback: strategy.lookback - 1 }), { code: 'STRATEGY_LOOKBACK' });
    const full = runStrategy(config, ticks(), strategy).report();
    const bounded = runStrategy(config, ticks(), strategy, { lookback: strategy.lookback }).report();
    assert.ok(full.fills.length > 0);
    assert.deepEqual(bounded, full);
  }
});

test('quote callbacks retain only working orders while reports and checkpoints retain the complete audit', () => {
  const quotes = ticks(300);
  let callbacks = 0;
  const strategy = context => {
    callbacks++;
    assert.equal(context.orders.length, 0, 'Each preceding one-lot order has already filled');
    const side = context.ledger.quantity === 0n ? 'buy' : 'sell';
    return [{ type: 'submit', side, limit: side === 'buy' ? context.history.at(-1).ask : context.history.at(-1).bid, quantity: '1' }];
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
