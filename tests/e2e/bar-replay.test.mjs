import test from 'node:test';
import assert from 'node:assert/strict';
import { runBarStrategy } from '../../src/bar-replay.mjs';
import { Backtest } from '../../src/framework.mjs';

const config = { instrument: { symbol: 'ETHUSDT-PROXY', currency: 'USDT-micro', lotSize: '0.001', priceTick: '10' },
  initialCash: '1000000', feePerLot: '10', orderLatencyMs: '1', cancelLatencyMs: '0', maxQuoteAgeMs: '100',
  manifest: { datasetVersion: 'e2e-bars', strategyArtifact: 'hold', evaluationProtocol: 'fixture', seed: '1' } };
const bars = (count = 5) => Array.from({ length: count }, (_, i) => ({ openTime: String(i * 100), closeTime: String((i + 1) * 100 - 1), availableAt: String((i + 1) * 100), open: '10000', high: '10100', low: '9900', close: '10000', volumeLots: '20' }));
const options = { maxPositionLots: '10', halfSpreadBps: '0', participationBps: '1000', maxLiquidityLots: '100', limitBufferBps: '100' };
const hold = () => ({ onBar: () => '10', lookback: 1 });

test('completed bars -> partial next-open fills -> exact fees/equity -> checkpoint replay', () => {
  const replay = runBarStrategy(config, bars(), hold(), options), report = replay.report();
  assert.equal(report.fills.length, 4);
  assert.deepEqual(report.fills.map(f => f.executionTime), ['101', '201', '301', '401']);
  assert.ok(report.fills.every(f => f.decisionTime === '100' && f.quantity === '2'));
  assert.deepEqual(report.ledger, { $: 'Ledger', cash: '919920', quantity: '8' });
  assert.equal(report.performance.terminalEquity, '999920');
  assert.equal(report.performance.netPnl, '-80');
  assert.equal(report.performance.fees, '80');
  assert.equal(report.orders[0].remaining, '2');
  assert.equal(report.barReplay.executionInputs[0].budgetPerSide, '0');
  assert.deepEqual(Backtest.resume(replay.backtest.checkpoint()).report(), replay.backtest.report());
});

test('actual spread, limit gaps, prior volume and final open inventory propagate through execution', () => {
  const input = bars(4);
  input[1] = { ...input[1], open: '11000', high: '11000', low: '10000' };
  input[1].volumeLots = '0'; // Known only at bar 1 completion, blocks bar 2.
  const report = runBarStrategy(config, input, hold(), { ...options, halfSpreadBps: '10' }).report();
  assert.ok(report.fills.every(fill => fill.executionTime !== '101' && fill.executionTime !== '201'));
  assert.ok(report.fills.length > 0);
  assert.equal(report.fills.at(-1).price, '10010');
  assert.equal(report.performance.terminalEquity, String(BigInt(report.ledger.cash) + BigInt(report.ledger.quantity) * 9990n));
  assert.ok(BigInt(report.ledger.quantity) > 0n, 'No invented end-of-data liquidation');
  assert.equal(report.barReplay.executionInputs[2].budgetPerSide, '0');
});

test('future candles cannot change earlier completed-bar decisions or fills', () => {
  const original = bars(8), changed = structuredClone(original);
  for (let i = 5; i < changed.length; i++) Object.assign(changed[i], { high: '999990', close: '999990', open: '999990', volumeLots: '0' });
  const strategy = () => ({ lookback: 2, onBar: ({ history }) => history.at(-1).close === '10000' ? '10' : '0' });
  const first = runBarStrategy(config, original, strategy(), options).report();
  const second = runBarStrategy(config, changed, strategy(), options).report();
  assert.deepEqual(first.trace.filter(event => BigInt(event.time) <= 500n), second.trace.filter(event => BigInt(event.time) <= 500n));
  assert.deepEqual(first.fills.filter(event => BigInt(event.executionTime) <= 500n), second.fills.filter(event => BigInt(event.executionTime) <= 500n));
});

test('missing/corrupt bars and impossible timing fail before strategy execution', () => {
  let calls = 0;
  const strategy = { onBar: () => { calls++; return '1'; }, lookback: 1 };
  const gap = bars(); gap.splice(2, 1);
  assert.throws(() => runBarStrategy(config, gap, strategy, options), { code: 'BAR_GAP' });
  const early = bars(); early[1].availableAt = early[1].closeTime;
  assert.throws(() => runBarStrategy(config, early, strategy, options), { code: 'BAR_TIME' });
  assert.throws(() => runBarStrategy(config, bars(), strategy, { ...options, executionDelayMs: '0' }), { code: 'INTEGER_RANGE' });
  assert.throws(() => runBarStrategy(config, bars(), strategy, { ...options, executionDelayMs: '100' }), { code: 'BAR_TIMING' });
  assert.equal(calls, 0);
  const arrayBar = bars(); arrayBar[0] = Object.assign([], arrayBar[0]);
  assert.throws(() => runBarStrategy(config, arrayBar, strategy, options), { code: 'BAR_SCHEMA' });
  const getter = bars(); Object.defineProperty(getter[0], 'open', { get: () => '10000', enumerable: true });
  assert.throws(() => runBarStrategy(config, getter, strategy, options), { code: 'BAR_SCHEMA' });
  assert.throws(() => runBarStrategy(config, bars(), { onBar() {}, lookback: 1 }, options), { code: 'BAR_STRATEGY_OUTPUT' });
});

test('returned bar evidence stays bound to the completed replay and captured diagnostics', () => {
  let diagnostic = 'original';
  const replay = runBarStrategy(config, bars(), { ...hold(), diagnostics: () => ({ diagnostic }) }, options);
  const report = replay.report(); diagnostic = 'changed';
  assert.throws(() => report.barReplay.executionInputs.pop(), TypeError);
  assert.throws(() => { report.barReplay.strategyDiagnostics.diagnostic = 'changed'; }, TypeError);
  assert.deepEqual(replay.report(), report);
  replay.backtest.step({ id: 'extra', type: 'clock', time: '501', sequence: String(replay.backtest.lastSequence + 1n), symbol: config.instrument.symbol, currency: config.instrument.currency });
  assert.throws(() => replay.report(), { code: 'BAR_REPLAY_CHANGED' });
});
