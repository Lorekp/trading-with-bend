import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Engine from '../build/engine.mjs';
import { Backtest, BacktestError, MAX_NAT, orders, runStrategy, hash, json } from '../src/framework.mjs';
import { validateModelArtifact, EvaluationSession, runExperiment } from '../src/research.mjs';

const demo = JSON.parse(readFileSync(new URL('../examples/demo.json', import.meta.url), 'utf8'));
const config = (extra = {}) => ({ ...structuredClone(demo.config), initialCash: '1000', feePerLot: '1', ...extra });
const base = (id, type, time, sequence = time) => ({ id, type, time: String(time), sequence: String(sequence), symbol: 'DEMO', currency: 'EUR' });
const submit = (id, time, quantity = '2', limit = '100', side = 'buy', sequence = time) => ({ ...base(`o${id}`, 'submit', time, sequence), orderId: String(id), side, limit, quantity });
const tick = (time, askLots = '100', ask = '100', bid = '99', sequence = time, bidLots = '100') => ({ ...base(`t${time}`, 'tick', time, sequence), sourceTime: String(time), bid, ask, askLots, bidLots });
const cancel = (id, time) => ({ ...base(`c${id}`, 'cancel', time), orderId: String(id) });
const clock = time => base(`clock${time}`, 'clock', time);
const code = expected => error => error instanceof BacktestError && error.code === expected;

test('demo produces exact ledger-based net P&L, including four fee postings', () => {
  const report = new Backtest(demo.config).run(demo.events).report();
  assert.equal(report.ledger.cash, '100260'); assert.equal(report.ledger.quantity, '0');
  assert.equal(report.performance.netPnl, '260'); assert.equal(report.performance.fees, '40');
  assert.equal(report.fills.length, 4);
  assert.equal(report.softwareChecks.bendCompiler, 'passed');
});
test('buy two at 100 with per-lot fee 1 leaves 798 and two units', () => {
  const run = new Backtest(config()).run([submit(1, 0), tick(1)]);
  assert.deepEqual(run.state.ledger, { $: 'Ledger', cash: 798n, quantity: 2n });
});
test('pending orders reserve capital without changing holdings', () => {
  const run = new Backtest(config({ initialCash: '250' }));
  run.step(submit(1, 0));
  assert.equal(run.state.ledger.cash, 250n); assert.equal(run.state.ledger.quantity, 0n);
  assert.equal(run.step(submit(2, 1)).status, 'rejected-capital-or-fee');
  assert.equal(orders(run.state).length, 1);
});
test('capital rejection near the backend bound does not overflow', () => {
  const run = new Backtest(config({ initialCash: String(MAX_NAT), feePerLot: '0' }));
  assert.equal(run.step(submit(1, 0, '1', String(MAX_NAT))).status, 'accepted');
  assert.equal(run.step(submit(2, 1, '1', String(MAX_NAT))).status, 'rejected-capital-or-fee');
  assert.equal(run.report().status, 'valid-under-declared-model');
});
test('returned fill objects cannot modify authoritative fee reporting', () => {
  const run = new Backtest(config()).run([submit(1, 0)]);
  const result = run.step(tick(1)); result.fills[0].fee = 999999n;
  assert.equal(run.report().performance.fees, '2');
  assert.throws(() => { run.fills[0].fee = 999999n; }, TypeError);
});
test('FIFO orders share a single liquidity budget across partial fills', () => {
  const run = new Backtest(config()).run([submit(1, 0, '3'), submit(2, 1, '3'), tick(2, '4')]);
  assert.deepEqual(orders(run.state).map(o => o.filled), [3n, 1n]);
  assert.equal(run.state.ledger.cash, 596n);
  run.step(tick(3, '1', '90', '89'));
  assert.deepEqual(orders(run.state).map(o => o.remaining), [0n, 1n]);
  assert.equal(run.report().reservations.cashReserved, '101');
});
test('price improvement, limits, zero liquidity and strict decision-time causality', () => {
  const run = new Backtest(config({ orderLatencyMs: '0' })).run([submit(1, 0, '2', '100', 'buy', 1), tick(0, '5', '90', '89', 2)]);
  assert.equal(run.fills.length, 0);
  run.step(tick(1, '10', '101', '99', 3)); assert.equal(run.fills.length, 0);
  run.step(tick(2, '0', '90', '89', 4)); assert.equal(run.fills.length, 0);
  run.step(tick(3, '1', '90', '89', 5)); assert.equal(run.state.ledger.cash, 909n);
});
test('order latency delays fills until arrival', () => {
  const run = new Backtest(config({ orderLatencyMs: '3' })).run([submit(1, 0), tick(1), tick(2)]);
  assert.equal(run.fills.length, 0); run.step(tick(3)); assert.equal(run.fills.length, 1);
});
test('fill before effective cancellation remains possible; cancellation wins time ties', () => {
  const run = new Backtest(config({ cancelLatencyMs: '2' })).run([submit(1, 0, '5'), cancel(1, 1), tick(2, '1'), tick(3)]);
  const [o] = orders(run.state);
  assert.equal(o.filled, 1n); assert.equal(o.cancelled, 4n); assert.equal(o.remaining, 0n);
  assert.equal(run.report().reservations.cashReserved, '0');
});
test('repeated cancel requests do not postpone earliest cancellation', () => {
  const run = new Backtest(config({ cancelLatencyMs: '3' })).run([submit(1, 0), cancel(1, 1), { ...cancel(1, 2), id: 'another-cancel' }, tick(4)]);
  assert.equal(orders(run.state)[0].cancelled, 2n);
});
test('no naked selling, inventory reuse, or fees exceeding sale limit', () => {
  const run = new Backtest(config());
  assert.equal(run.step(submit(1, 0, '1', '100', 'sell')).status, 'rejected-capital-or-fee');
  run.run([submit(2, 1), tick(2), submit(3, 3, '2', '100', 'sell')]);
  assert.equal(run.step(submit(4, 4, '1', '100', 'sell')).status, 'rejected-capital-or-fee');
  run.step(tick(5, '0', '110', '109', 5, '1'));
  assert.equal(run.state.ledger.cash, 906n); assert.equal(run.state.ledger.quantity, 1n);
});
test('duplicate events are idempotent, changed duplicate IDs fail', () => {
  const events = [submit(1, 0), tick(1)], run = new Backtest(config()).run(events);
  const before = json(run.checkpoint());
  assert.equal(run.step(events[1]).duplicate, true); assert.equal(json(run.checkpoint()), before);
  assert.throws(() => run.step({ ...events[1], askLots: '99' }), code('EVENT_ID_COLLISION'));
});
test('malformed, stale, out-of-order and cross-currency data fail closed', () => {
  for (const [event, expected] of [
    [{ ...tick(1), bid: '101' }, 'CROSSED_QUOTE'],
    [{ ...tick(1), ask: 100 }, 'INVALID_INTEGER'],
    [{ ...tick(1), currency: 'USD' }, 'UNIT_MISMATCH'],
    [{ ...tick(1), sourceTime: '0' }, 'NON_EXECUTABLE_QUOTE'],
    [{ ...tick(1), askLots: undefined }, 'INVALID_INTEGER'],
    [{ ...submit(1, 0), quantity: '0' }, 'INTEGER_RANGE'],
    [{ ...submit(1, 0), type: 'stop' }, 'UNSUPPORTED_EVENT'],
    [{ ...submit(1, 0), leverage: '2' }, 'UNSUPPORTED_FIELD']
  ]) assert.throws(() => new Backtest(config()).step(event), code(expected));
  const run = new Backtest(config()).run([tick(2)]);
  assert.throws(() => run.step(tick(1)), code('OUT_OF_ORDER'));
  assert.throws(() => run.step(tick(3, '1', '100', '99', 2)), code('OUT_OF_ORDER'));
});
test('Nat backend overflow is an error and event application is atomic', () => {
  const run = new Backtest(config()); const snapshot = json(run.state);
  assert.throws(() => run.step(submit(1, 0, '2', String(MAX_NAT))), code('ARITHMETIC_RANGE'));
  assert.equal(json(run.state), snapshot); assert.equal(run.events.length, 0);
  assert.throws(() => run.report(), code('RUN_FAILED'));
  const large = new Backtest(config({ initialCash: String(MAX_NAT), feePerLot: '0' }));
  large.run([submit(1, 0, '1', '1'), tick(1, '1', '1', '1')]);
  const prior = json(large.state);
  assert.throws(() => large.step(tick(2, '0', String(MAX_NAT), String(MAX_NAT))), code('ARITHMETIC_RANGE'));
  assert.equal(json(large.state), prior); assert.equal(large.events.length, 2);
  assert.throws(() => Backtest.resume(large.checkpoint()).report(), code('RUN_FAILED'));
});
test('checkpoint continuation exactly matches uninterrupted execution at every boundary', () => {
  const full = new Backtest(demo.config).run(demo.events).report();
  for (let i = 0; i <= demo.events.length; i++) {
    const prefix = new Backtest(demo.config).run(demo.events.slice(0, i));
    const resumed = Backtest.resume(JSON.parse(json(prefix.checkpoint()))).run(demo.events.slice(i)).report();
    assert.deepEqual(resumed, full);
  }
  const corrupt = new Backtest(config()).checkpoint(); corrupt.config.initialCash = '999';
  assert.throws(() => Backtest.resume(corrupt), code('CHECKPOINT_CORRUPT'));
});
test('open losses remain in performance; stale terminal positions invalidate report', () => {
  const run = new Backtest(config({ maxQuoteAgeMs: '2' })).run([submit(1, 0), tick(1, '2', '100', '80')]);
  assert.equal(run.report().performance.netPnl, '-42');
  assert.equal(run.report().performance.terminalEquity, '958');
  run.step(clock(4)); const report = run.report();
  assert.equal(report.status, 'invalid-terminal-valuation'); assert.equal(report.performance.netPnl, null);
});
test('empty run has undefined drawdown/Sharpe and zero P&L', () => {
  const p = new Backtest(config()).report().performance;
  assert.equal(p.maxDrawdownAtQuoteSamples, null); assert.equal(p.sharpe.value, null); assert.equal(p.netPnl, '0');
});
test('strategy receives immutable prefixes and decisions cannot fill on observed quote', () => {
  const observed = [];
  const run = runStrategy(config({ orderLatencyMs: '0' }), [tick(1), tick(2)], view => {
    observed.push(view.history.length);
    assert.throws(() => view.history.push({}), TypeError);
    return view.history.length === 1 ? [{ type: 'submit', side: 'buy', quantity: '1', limit: '100' }] : [];
  });
  assert.deepEqual(observed, [1, 2]); assert.equal(run.fills[0].executionTime, 2n);
});
test('strategy validates source sequences before assigning internal event sequences', () => {
  for (const sequence of ['9', '10', undefined, 'invalid']) {
    const quotes = [tick(1, '1', '100', '99', '10'), { ...tick(1), id: 'second', sequence }];
    assert.throws(() => runStrategy(config(), quotes, () => []), { code: sequence === '9' || sequence === '10' ? 'OUT_OF_ORDER' : 'INVALID_INTEGER' });
  }
  const quotes = [tick(1, '1', '100', '99', '10'), { ...tick(1, '1', '100', '99', '20'), id: 'second' }];
  const run = runStrategy(config(), quotes, ({ tickCount }) => tickCount === 1 ? [{ type: 'submit', side: 'buy', quantity: '1', limit: '100' }] : []);
  assert.deepEqual(run.events.map(event => event.sequence), ['1', '2', '3']);
  assert.equal(run.fills.length, 0);
});

test('generated ledger functions match independent BigInt arithmetic over many inputs', () => {
  let random = 98765n;
  const next = max => { random = (random * 48271n) % 2147483647n; return random % max; };
  for (let i = 0; i < 500; i++) {
    const price = next(10000n) + 1n, fee = next(100n), lots = next(100n), spare = next(100000n), quantity = next(100n);
    assert.deepEqual(Engine.buy((price + fee) * lots + spare, quantity, price, lots, fee), { $: 'Ledger', cash: spare, quantity: quantity + lots });
    assert.deepEqual(Engine.sell(spare, quantity + lots, price + fee, lots, fee), { $: 'Ledger', cash: spare + price * lots, quantity });
  }
});
test('randomized FIFO matching agrees with independent reference allocation', () => {
  let random = 123n;
  const next = max => { random = (random * 16807n) % 2147483647n; return random % max; };
  for (let scenario = 0; scenario < 60; scenario++) {
    const run = new Backtest(config({ initialCash: '1000000' }));
    const reference = []; let cash = 1000000n, inventory = 0n;
    for (let i = 0; i < 8; i++) {
      const remaining = next(9n) + 1n, limit = next(20n) + 90n;
      reference.push({ remaining, limit, filled: 0n }); run.step(submit(i + 1, i, String(remaining), String(limit)));
    }
    for (let t = 8; t < 18; t++) {
      const ask = next(25n) + 85n; let liquidity = next(13n);
      run.step(tick(t, String(liquidity), String(ask), String(ask - 1n)));
      for (const o of reference) if (ask <= o.limit) {
        const quantity = o.remaining < liquidity ? o.remaining : liquidity;
        o.remaining -= quantity; o.filled += quantity; liquidity -= quantity;
        cash -= quantity * (ask + 1n); inventory += quantity;
      }
    }
    assert.equal(run.state.ledger.cash, cash); assert.equal(run.state.ledger.quantity, inventory);
    assert.deepEqual(orders(run.state).map(o => [o.remaining, o.filled]), reference.map(o => [o.remaining, o.filled]));
  }
});
test('model availability binds feature schema, preprocessing fold and label maturity', () => {
  const schema = [{ name: 'return', unit: 'ratio', missing: 'reject' }];
  const artifact = { featureSchemaHash: hash(schema), modelHash: hash('model'), preprocessingHash: hash('scaler'), fold: '1', preprocessingFold: '1', lastLabelAvailableAt: '10', trainingStartedAt: '10', trainingCompletedAt: '12', deployedAt: '13' };
  assert.equal(validateModelArtifact(artifact, schema, '13'), true);
  assert.throws(() => validateModelArtifact(artifact, schema, '12'), code('MODEL_NOT_AVAILABLE'));
  assert.throws(() => validateModelArtifact({ ...artifact, trainingStartedAt: '9' }, schema, '13'), code('MODEL_NOT_AVAILABLE'));
  assert.throws(() => validateModelArtifact({ ...artifact, preprocessingFold: '2' }, schema, '13'), code('FOLD_MISMATCH'));
  assert.throws(() => validateModelArtifact(artifact, [...schema, { name: 'volume' }], '13'), code('FEATURE_SCHEMA'));
});
test('selection cannot authorize final data, final protocol is fixed and single-use', () => {
  const digest = hash('strategy'), session = new EvaluationSession({ id: 'holdout-v1', strategyHash: digest });
  assert.throws(() => session.authorize('select', 'final', digest), code('FINAL_TEST_ACCESS'));
  assert.throws(() => session.authorize('final', 'final', hash('changed')), code('STRATEGY_CHANGED'));
  session.authorize('final', 'final', digest);
  assert.throws(() => session.authorize('final', 'final', digest), code('FINAL_TEST_REUSE'));
});
test('experiment registry records successful and failed work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bend-experiments-'));
  runExperiment(directory, { a: 1 }, () => ({ value: 42 }));
  assert.throws(() => runExperiment(directory, { a: 2 }, () => { throw new Error('failed training'); }));
  const records = readdirSync(directory).map(file => JSON.parse(readFileSync(join(directory, file), 'utf8')));
  assert.deepEqual(records.map(r => r.status).sort(), ['completed', 'failed']);
});
