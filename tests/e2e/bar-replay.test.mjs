import test from 'node:test';
import assert from 'node:assert/strict';
import { replayBars as runBarStrategy } from '../replay-fixtures.mjs';
import { Backtest } from '../../src/framework.mjs';
import { InformationSource, barInformationSource } from '../../src/information-source.mjs';
import { BarExecutionVenue } from '../../src/bar-execution-venue.mjs';
import { QuoteExecutionVenue } from '../../src/execution-venue.mjs';
import { runBarStrategy as runSeparateBars } from '../../src/bar-replay.mjs';
import { runStrategy } from '../../src/replay.mjs';
import { buyAndHold } from '../../src/strategies.mjs';

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
  report.barReplay.strategyDiagnostics.diagnostic = 'changed';
  assert.equal(replay.report().barReplay.strategyDiagnostics.diagnostic, 'original');
  report.barReplay.strategyDiagnostics.diagnostic = 'original';
  assert.deepEqual(replay.report(), report);
  replay.backtest.step({ id: 'extra', type: 'clock', time: '501', sequence: String(replay.backtest.lastSequence + 1n), symbol: config.instrument.symbol, currency: config.instrument.currency });
  assert.throws(() => replay.report(), { code: 'VENUE_REPLAY_CHANGED' });
});

test('source and venue swap independently: Binance -> Hyperliquid, Hyperliquid -> Hyperliquid, OKX -> Kraken', () => {
  // Names identify fixtures, not real exchange connectors or calibrated costs.
  const sourceBars = bars(), differentSource = bars().map(bar => ({ ...bar, open: '90000', high: '91000', low: '89000', close: '90000', volumeLots: '999999' }));
  const replay = (sourceId, input, venueId, executionBars, fee = '10') => {
    const source = barInformationSource({ id: sourceId, instrument: config.instrument, bars: input });
    const venue = new BarExecutionVenue({ id: venueId, config: { ...config, feePerLot: fee }, bars: executionBars, ...options });
    const seen = [];
    const report = runSeparateBars(source, venue, { onBar(context) {
      seen.push(context.bar.close);
      assert.ok(!('executionVenue' in context) && !('informationSource' in context));
      return '10';
    } }).report();
    return { report, seen };
  };
  const a = replay('binance', sourceBars, 'hyperliquid', bars());
  const b = replay('hyperliquid', differentSource, 'hyperliquid', bars());
  assert.notDeepEqual(a.seen, b.seen);
  for (const key of ['fills', 'orders', 'ledger', 'performance', 'valuations', 'traceHash']) assert.deepEqual(a.report[key], b.report[key], key);
  assert.notEqual(a.report.routing.informationSource.datasetHash, b.report.routing.informationSource.datasetHash);
  assert.deepEqual(a.report.routing.executionVenue, b.report.routing.executionVenue);
  const krakenBars = bars().map(bar => ({ ...bar, open: '20000', high: '20100', low: '19900', close: '20000', volumeLots: '10' }));
  const c = replay('okx', differentSource, 'kraken', krakenBars, '30');
  assert.ok(c.report.fills.every(fill => fill.price === '20000' && fill.quantity === '1' && fill.fee === '30'));
  assert.equal(c.report.performance.netPnl, '-120');
  assert.equal(c.report.routing.executionVenue.id, 'kraken');
  assert.equal(c.report.routing.executionVenue.funding, 'unsupported');
  assert.equal(c.report.routing.executionVenue.margin, 'cash-only-no-leverage');
});

test('the same bar strategy can use a quote venue without source prices or volume supplying execution', () => {
  const input = bars();
  const ticks = [100, 101, 200, 201, 300, 301, 400, 401, 500].map((time, index) => ({
    id: `execution-${index}`, type: 'tick', time: String(time), sourceTime: String(time), sequence: String(index),
    symbol: config.instrument.symbol, currency: config.instrument.currency, bid: '29990', ask: '30000', bidLots: '1', askLots: '1',
  }));
  const source = barInformationSource({ id: 'information', instrument: config.instrument, bars: input });
  const venue = new QuoteExecutionVenue({ id: 'quote-execution', config, ticks, maxPositionLots: '10' });
  const report = runSeparateBars(source, venue, hold()).report();
  assert.ok(report.fills.length > 0);
  assert.ok(report.fills.every(fill => fill.price === '30000' && BigInt(fill.executionTime) > BigInt(fill.decisionTime)));
  assert.equal(report.valuations.at(-1).mark, '29990');
  const emptyVenue = new QuoteExecutionVenue({ id: 'no-execution-data', config, ticks: [], maxPositionLots: '10' });
  const empty = runSeparateBars(source, emptyVenue, hold()).report();
  assert.equal(empty.fills.length, 0);
  assert.equal(empty.orders.length, 0);
  assert.equal(empty.valuations.length, 0);
  assert.equal(empty.performance.netPnl, '0');
});

test('delayed feature availability gates decisions while venue events progress independently and stale marks invalidate PnL', () => {
  const source = new InformationSource({ id: 'delayed-features', instrument: config.instrument, observations: [
    { time: '1', availableAt: '103', data: { score: 1 } },
    { time: '2', availableAt: '500', data: { score: 0 } },
  ] });
  const ticks = [100, 103, 104].map((time, index) => ({ id: `venue-${index}`, type: 'tick', time: String(time), sourceTime: String(time), sequence: String(index),
    symbol: config.instrument.symbol, currency: config.instrument.currency, bid: '9990', ask: '10000', bidLots: '1', askLots: '1' }));
  const venue = new QuoteExecutionVenue({ id: 'independent-clock', config, ticks, maxPositionLots: '1' });
  const times = [];
  const report = runStrategy(source, venue, context => { times.push(context.time); return '1'; }).report();
  assert.deepEqual(times, ['103', '500']);
  assert.equal(report.fills[0].executionTime, '104');
  assert.equal(report.fills[0].decisionTime, '103');
  assert.equal(report.status, 'invalid-terminal-valuation');
  assert.equal(report.performance.netPnl, null);
  assert.equal(report.orders.length, 1);
  assert.throws(() => runStrategy(source, venue, () => null), { code: 'VENUE_REUSED' });
});

test('a foreign execution venue owns funding, margin and PnL without any Bend defaults', () => {
  const source = new InformationSource({ id: 'features', instrument: config.instrument,
    observations: [{ time: '1', availableAt: '2', data: { score: 1 } }] });
  const calls = [], venueReport = { fills: [{ price: '123' }], performance: { fees: '17', funding: '-9', netPnl: '1234' },
    margin: { initial: '50', maintenance: '25', liquidations: 0 } };
  const venue = {
    instrument: config.instrument, manifest: { id: 'foreign-contract-fixture', model: 'test-only' },
    advanceTo: time => calls.push(['advance', time]),
    snapshot: () => ({ ledger: { cash: 1000n, quantity: 0n }, orders: [], equity: 1234n, funding: { accrued: '-9' }, margin: venueReport.margin }),
    setTarget: (...args) => calls.push(['target', ...args]), finish: time => calls.push(['finish', time]), report: () => structuredClone(venueReport),
  };
  const report = runStrategy(source, venue, context => {
    assert.equal(context.equity, 1234n);
    assert.equal(context.account.funding.accrued, '-9');
    assert.throws(() => { context.account.margin.initial = '0'; }, TypeError);
    return '10';
  }).report();
  assert.deepEqual(calls, [['advance', '2'], ['target', '10', '2'], ['finish', '2']]);
  assert.deepEqual(report.performance, venueReport.performance);
  assert.deepEqual(report.margin, venueReport.margin);
  assert.deepEqual(report.fills, venueReport.fills);
  assert.ok(!('softwareChecks' in report));
});

test('adapter contracts reject mismatched units, unavailable observations and order-producing strategies', () => {
  const source = barInformationSource({ id: 'information', instrument: config.instrument, bars: bars() });
  const venue = () => new QuoteExecutionVenue({ id: 'venue', config, ticks: [], maxPositionLots: '10' });
  for (const change of [{ currency: 'EUR' }, { lotSize: '1' }, { symbol: 'OTHER' }]) {
    const wrong = new InformationSource({ id: 'wrong-units', instrument: { ...config.instrument, ...change }, observations: [] });
    assert.throws(() => runStrategy(wrong, venue(), () => assert.fail()), { code: 'UNIT_MISMATCH' });
  }
  assert.throws(() => new InformationSource({ id: 'future', instrument: config.instrument, observations: [{ time: '3', availableAt: '2', data: {} }] }), { code: 'INFORMATION_TIME' });
  assert.throws(() => new InformationSource({ id: 'reordered', instrument: config.instrument, observations: [
    { time: '1', availableAt: '4', data: {} }, { time: '2', availableAt: '3', data: {} },
  ] }), { code: 'INFORMATION_TIME' });
  assert.throws(() => runStrategy(source, venue(), () => [{ type: 'submit', limit: '1', quantity: '1' }]), { code: 'STRATEGY_OUTPUT' });
  assert.throws(() => runStrategy(source, venue(), () => '1', { feePerLot: '0' }), { code: 'STRATEGY_OPTION' });
  assert.throws(() => buyAndHold({ quantity: '1', feePerLot: '0' }), { code: 'STRATEGY_PARAMETER' });
  assert.throws(() => new QuoteExecutionVenue({ id: 'unsupported', config, ticks: [], maxPositionLots: '1', funding: '0' }), { code: 'VENUE_OPTION' });
  assert.throws(() => new BarExecutionVenue({ id: 'unsupported', config, bars: bars(), maxPositionLots: '1', leverage: '10' }), { code: 'BAR_OPTION' });
});

test('venue clock and strategy event IDs cannot collide with execution tick IDs', () => {
  const source = new InformationSource({ id: 'signals', instrument: config.instrument,
    observations: [5, 10, 12].map(time => ({ time: String(time), availableAt: String(time), data: {} })) });
  const ticks = ['venue-clock-1', 'strategy-3', 'venue-clock-1-'].map((id, index) => ({
    id, type: 'tick', time: String(10 + index), sourceTime: String(10 + index), sequence: String(index + 1),
    symbol: config.instrument.symbol, currency: config.instrument.currency, bid: '9990', ask: '10000', bidLots: '1', askLots: '1',
  }));
  const venue = new QuoteExecutionVenue({ id: 'execution', config, ticks, maxPositionLots: '1' });
  const report = runStrategy(source, venue, () => '1').report();
  assert.equal(report.fills.length, 1);
  assert.equal(report.fills[0].marketEventId, 'strategy-3');
  assert.equal(report.fills[0].executionTime, '11');
  assert.equal(new Set(report.trace.map(event => event.eventId)).size, report.trace.length);
});
