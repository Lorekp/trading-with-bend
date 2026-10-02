import test from 'node:test';
import assert from 'node:assert/strict';
import { createBarStrategy } from '../../src/bar-strategies.mjs';
import { runBarStrategy } from '../../src/bar-replay.mjs';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const config = () => ({ instrument: { symbol: 'ETHUSDT', currency: 'USDT', lotSize: '0.001', priceTick: '1' }, initialCash: '1000000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '1000', manifest: { datasetVersion: 'synthetic-e2e-only', strategyArtifact: 'bar-strategy-test', evaluationProtocol: 'fixed-fixture', seed: '1' } });
function bars(closes, { interval = 1000, volume = 100000 } = {}) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return freeze({ openTime: String(i * interval), closeTime: String((i + 1) * interval - 1), availableAt: String((i + 1) * interval),
      open: String(open), high: String(Math.max(open, close) + 1), low: String(Math.min(open, close) - 1), close: String(close), volumeLots: String(volume) });
  });
}
function signals(spec, input, strategy = createBarStrategy(spec)) {
  const targets = [];
  const observed = {
    ...strategy,
    onBar(context) { const target = strategy.onBar(context); targets.push(target); return target; },
  };
  const replay = runBarStrategy(config(), input, observed, {
    maxPositionLots: spec.quantity, halfSpreadBps: '0', participationBps: '1000', limitBufferBps: '100',
  });
  const report = replay.report();
  return { targets, diagnostics: report.barReplay.strategyDiagnostics, report };
}

test('hold snapshots its configuration and moving averages use exact completed closes with explicit warmup', () => {
  const spec = { type: 'hold', quantity: '10' }, hold = createBarStrategy(spec), input = bars([10, 10, 10, 12, 8]);
  spec.quantity = '99';
  const held = signals(spec, input, hold);
  assert.ok(held.targets.every(target => target === '10'));
  assert.equal(held.report.ledger.quantity, '10'); assert.equal(held.report.fills.length, 1);
  const ma = signals({ type: 'ma-cross', quantity: '15', fast: 2, slow: 3 }, input);
  assert.deepEqual(ma.targets, [null, null, '0', '15', '0']);
  assert.equal(ma.diagnostics.warmupBars, 2);
  assert.equal(ma.report.fills[0].marketEventId, 'bar-open-4');
  assert.equal(ma.report.ledger.quantity, '15', 'Final close exit signal cannot invent another opening fill');
  assert.throws(() => signals(spec, input, hold), { code: 'STRATEGY_ORDER' }, 'A reused strategy cannot restart against another ledger');
});

test('volatility breakout excludes current bar from entry channel and exits with actual-position cooldown', () => {
  const spec = { type: 'volatility-breakout', quantity: '10', entryWindow: 2, exitWindow: 2, atrWindow: 2, trendWindow: 3, trailingAtr: 1, riskBps: '100', cooldownBars: 3 };
  const result = signals(spec, bars([100, 101, 102, 110, 115, 130, 100, 120, 140, 160, 180]));
  assert.equal(result.targets[3], '10', 'New closing breakout compares to previous highs');
  assert.equal(result.targets[6], '0', 'Completed closing reversal triggers an exit');
  assert.deepEqual(result.targets.slice(7, 10), ['0', '0', '0']);
  assert.equal(result.targets[10], '10');
  assert.equal(result.diagnostics.trailingExits, 1); assert.equal(result.diagnostics.filledEntries, 1); assert.equal(result.diagnostics.filledExits, 1);
  assert.equal(result.diagnostics.cooldownBlocks, 3);
  assert.deepEqual(result.report.fills.map(fill => [fill.side, fill.marketEventId, fill.quantity]), [
    ['buy', 'bar-open-4', '10'], ['sell', 'bar-open-7', '10'],
  ]);
  assert.equal(result.report.ledger.quantity, '0', 'Final breakout remains a signal with no fabricated fill');
});

test('breakout sizing decreases with volatility and never exceeds declared lot cap', () => {
  const spec = { type: 'volatility-breakout', quantity: '100000', entryWindow: 2, exitWindow: 2, atrWindow: 2, trendWindow: 3, trailingAtr: 2, riskBps: '10', cooldownBars: 0 };
  const lowRun = signals(spec, bars([100, 101, 102, 110, 110]));
  const highRun = signals(spec, bars([100, 101, 102, 150, 150]));
  const low = lowRun.targets[3], high = highRun.targets[3];
  assert.ok(BigInt(low) > BigInt(high)); assert.ok(BigInt(high) > 0n); assert.ok(BigInt(low) <= BigInt(spec.quantity));
  assert.ok(lowRun.report.fills.length > 0 && highRun.report.fills.length > 0);
  assert.ok(BigInt(lowRun.report.ledger.quantity) > BigInt(highRun.report.ledger.quantity), 'Volatility-adjusted sizing changes executed holdings');
});

const mlSpec = { type: 'walkforward-ridge', quantity: '10', featureWindow: 3, trainingWindow: 8, minTrain: 4, retrainEvery: 3, alpha: 1, entryThreshold: -0.1, exitThreshold: -0.2, trainingTimeMs: '1', deploymentDelayMs: '1' };
const mlBars = count => bars(Array.from({ length: count }, (_, i) => 1000 + 2 * i + Math.round(10 * Math.sin(i / 3))));

test('walkforward ridge trains only matured labels, deploys after training, and bounds fit rows', () => {
  const result = signals(mlSpec, mlBars(50)), { fits, predictions, labeledPredictions, lastPrediction } = result.diagnostics;
  assert.ok(fits.length > 3); assert.ok(predictions > 0); assert.equal(labeledPredictions, predictions - 1);
  for (const fit of fits) {
    assert.ok(fit.rowCount >= mlSpec.minTrain && fit.rowCount <= mlSpec.trainingWindow);
    assert.ok(BigInt(fit.lastLabelAvailableAt) < BigInt(fit.cutoff));
    assert.ok(BigInt(fit.lastObservationTime) < BigInt(fit.lastLabelAvailableAt));
    assert.ok(BigInt(fit.cutoff) <= BigInt(fit.trainingStartedAt));
    assert.ok(BigInt(fit.trainingStartedAt) < BigInt(fit.trainingCompletedAt));
    assert.ok(BigInt(fit.trainingCompletedAt) < BigInt(fit.deployedAt));
    assert.match(fit.modelHash, /^[a-f0-9]{64}$/); assert.match(fit.preprocessingHash, /^[a-f0-9]{64}$/);
  }
  assert.ok(BigInt(lastPrediction.modelDeployedAt) <= BigInt(lastPrediction.decisionTime));
  assert.ok(Number.isFinite(result.diagnostics.mse)); assert.ok(Number.isFinite(result.diagnostics.mae));
  assert.equal(result.targets.findIndex(target => target !== null), 10, 'Fit at bar 9 only becomes available at bar 10');
  assert.equal(result.report.fills[0].marketEventId, 'bar-open-11');
  assert.equal(result.report.fills[0].decisionTime, '11000');
  assert.ok(BigInt(result.report.fills[0].decisionTime) >= BigInt(fits[0].deployedAt));
});

test('long training/deployment delays suppress use of pending model and preserve prior active model', () => {
  const result = signals({ ...mlSpec, deploymentDelayMs: '5000' }, mlBars(40));
  assert.equal(result.targets.findIndex(target => target !== null), 15);
  assert.ok(result.diagnostics.fits.length > 1);
  assert.ok(BigInt(result.diagnostics.lastPrediction.modelDeployedAt) <= BigInt(result.diagnostics.lastPrediction.decisionTime));
  assert.equal(result.report.fills[0].marketEventId, 'bar-open-16');
  assert.ok(BigInt(result.report.fills[0].decisionTime) >= BigInt(result.diagnostics.fits[0].deployedAt));
});

test('every strategy is prefix-invariant and fresh instances replay identically', () => {
  const input = mlBars(50), variants = [
    { type: 'hold', quantity: '10' }, { type: 'ma-cross', quantity: '10', fast: 2, slow: 5 },
    { type: 'volatility-breakout', quantity: '10', entryWindow: 3, exitWindow: 2, atrWindow: 3, trendWindow: 5 }, mlSpec,
  ];
  for (const spec of variants) {
    const prefix = signals(spec, input.slice(0, 30)), full = signals(spec, input);
    assert.deepEqual(full.targets.slice(0, 30), prefix.targets, spec.type);
    assert.deepEqual(full.report.fills.filter(fill => BigInt(fill.executionTime) <= BigInt(input[29].availableAt)), prefix.report.fills, `${spec.type} earlier execution is prefix invariant`);
    assert.deepEqual(signals(spec, input), full, spec.type);
  }
});

test('all four strategies drive the Bend cash ledger through the completed-bar bridge', () => {
  const input = mlBars(70), variants = [
    { type: 'hold', quantity: '10' }, { type: 'ma-cross', quantity: '10', fast: 2, slow: 5 },
    { type: 'volatility-breakout', quantity: '10', entryWindow: 3, exitWindow: 2, atrWindow: 3, trendWindow: 5, trailingAtr: 2 }, mlSpec,
  ];
  for (const spec of variants) {
    const replay = runBarStrategy(config(), input, createBarStrategy(spec), { maxPositionLots: '10', halfSpreadBps: '0', participationBps: '1000', limitBufferBps: '100' });
    const report = replay.report();
    assert.ok(report.fills.length > 0, `${spec.type} should execute real engine fills`);
    assert.equal(report.barReplay.count, input.length); assert.equal(report.barReplay.strategyDiagnostics.bars, input.length);
    assert.ok(BigInt(report.ledger.quantity) <= 10n); assert.ok(BigInt(report.ledger.cash) >= 0n);
    const ledger = report.fills.reduce((state, fill) => ({
      cash: state.cash + (fill.side === 'buy' ? -1n : 1n) * BigInt(fill.quantity) * BigInt(fill.price) - BigInt(fill.fee),
      quantity: state.quantity + (fill.side === 'buy' ? 1n : -1n) * BigInt(fill.quantity),
    }), { cash: BigInt(config().initialCash), quantity: 0n });
    assert.equal(String(ledger.cash), report.ledger.cash); assert.equal(String(ledger.quantity), report.ledger.quantity);
    for (const fill of report.fills) {
      assert.ok(BigInt(fill.executionTime) > BigInt(fill.decisionTime));
      assert.match(fill.marketEventId, /^bar-open-/);
      const evidence = report.barReplay.executionInputs.find(item => item.eventId === fill.marketEventId);
      assert.ok(BigInt(fill.quantity) <= BigInt(evidence.budgetPerSide));
      assert.ok(BigInt(evidence.priorAvailableAt) < BigInt(fill.executionTime));
    }
    const again = runBarStrategy(config(), input, createBarStrategy(spec), { maxPositionLots: '10', halfSpreadBps: '0', participationBps: '1000', limitBufferBps: '100' }).report();
    assert.deepEqual(again.fills, report.fills); assert.equal(again.barReplay.targetsHash, report.barReplay.targetsHash);
  }
});

test('next-bar volume cannot fund current opening fills', () => {
  const input = bars([100, 100, 100, 100], { volume: 0 }).map((bar, i) => ({ ...bar, volumeLots: i === 1 ? '1000000' : '0' }));
  const replay = runBarStrategy(config(), input, createBarStrategy({ type: 'hold', quantity: '10' }), { maxPositionLots: '10', halfSpreadBps: '0', participationBps: '10000' });
  const fills = replay.report().fills;
  assert.equal(fills.length, 1); assert.equal(fills[0].marketEventId, 'bar-open-2');
});

test('malformed strategy options fail before the engine can produce fills', () => {
  const input = mlBars(30);
  for (const spec of [
    { type: 'hold', quantity: '10', qunatity: '1000' },
    { type: 'ma-cross', quantity: '10', entryWindow: 3 },
    { type: 'ma-cross', quantity: '1', fast: 3, slow: 3 },
    { type: 'volatility-breakout', quantity: '10', riskBps: NaN },
    { ...mlSpec, trainingWindows: 128 },
    { ...mlSpec, recordModels: 'yes' },
  ]) {
    let replay;
    assert.throws(() => { replay = runBarStrategy(config(), input, createBarStrategy(spec), { maxPositionLots: '10' }); });
    assert.equal(replay, undefined, 'Invalid experiment must not produce a replay or fill report');
  }
});

test('real bridge replay retains complete immutable model/scaler artifacts matched to every fit', () => {
  const strategy = createBarStrategy(mlSpec);
  const report = runBarStrategy(config(), mlBars(50), strategy, { maxPositionLots: '10', halfSpreadBps: '0' }).report();
  const models = strategy.modelArtifacts(), fits = report.barReplay.strategyDiagnostics.fits;
  assert.ok(models.length > 0); assert.equal(models.length, fits.length);
  for (let i = 0; i < models.length; i++) {
    assert.equal(models[i].hash, fits[i].modelHash); assert.equal(models[i].preprocessing.hash, fits[i].preprocessingHash);
    assert.equal(models[i].trainingRowIds.length, fits[i].rowCount); assert.equal(models[i].trainingDataHash, fits[i].trainingDataHash);
  }
  models[0].coefficients[0] = 999;
  assert.notEqual(strategy.modelArtifacts()[0].coefficients[0], 999, 'Returned artifacts cannot mutate fitted parameters');
  const unrecorded = createBarStrategy({ ...mlSpec, recordModels: false });
  const unrecordedReport = runBarStrategy(config(), mlBars(50), unrecorded, { maxPositionLots: '10', halfSpreadBps: '0' }).report();
  assert.deepEqual(unrecorded.modelArtifacts(), []); assert.equal(unrecordedReport.barReplay.strategyDiagnostics.recordModels, false);
  assert.equal(unrecordedReport.barReplay.targetsHash, report.barReplay.targetsHash);
});
