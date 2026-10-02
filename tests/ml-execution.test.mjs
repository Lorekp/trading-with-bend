import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures } from '../src/features.mjs';
import { fitRidge, predictRidge } from '../src/models.mjs';
import { targetPosition } from '../src/strategies.mjs';
import { runStrategy } from '../src/framework.mjs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from '../src/framework.mjs';
import { foldRows, walkForwardSplits, withFinalHoldout } from '../src/evaluation.mjs';
import { fitForecast, predictForecast, forecastRuntime } from '../src/forecast.mjs';
import { enqueueExperiment, runQueue, readExperimentResult, verifyExperimentArtifacts } from '../src/experiments.mjs';
import { ethForecastData, fixtureBars } from '../experiments/eth-forecast/data.mjs';

test('a trained model target produces causal executable fills through the shared ledger', () => {
  const schema = [{ name: 'price', source: 'price', kind: 'value', unit: 'quote-minor-per-lot' }];
  const features = computeFeatures([10, 11, 12].map((price, i) => ({ time: String(i), availableAt: String(i), values: { price } })), schema);
  const rows = features.map((feature, i) => ({ id: `train-${i}`, partition: 'train', feature, target: 0.01, labelAvailableAt: String(i + 1) }));
  const model = fitRidge({ rows, schema, fold: 'train-before-five', cutoff: '4', trainingStartedAt: '4', trainingCompletedAt: '5', deployedAt: '5', alpha: 1 });
  const instrument = { symbol: 'ML', currency: 'EUR', priceTick: '1', lotSize: '1' };
  const ticks = [5, 6].map(time => ({ id: `tick-${time}`, type: 'tick', time: String(time), sourceTime: String(time), sequence: String(time), symbol: 'ML', currency: 'EUR', bid: '99', ask: '100', bidLots: '10', askLots: '10' }));
  const observed = computeFeatures(ticks.map(tick => ({ time: tick.time, availableAt: tick.time, values: { price: 100 } })), schema);
  const strategy = targetPosition(({ history }) => {
    const time = history.at(-1).time, feature = observed.find(row => row.time === time);
    const prediction = predictRidge({ model, feature, schema, fold: model.fold, decisionTime: time });
    return prediction.prediction > 0 ? '2' : '0';
  }, { feePerLot: '1', maxPositionLots: '2' });
  const config = { instrument, initialCash: '1000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '10', manifest: { datasetVersion: 'analytic-ml-execution', strategyArtifact: model.hash, evaluationProtocol: 'independent-test', seed: 'none' } };
  const report = runStrategy(config, ticks, strategy).report();
  assert.equal(report.fills.length, 1); assert.equal(report.fills[0].decisionTime, '5'); assert.equal(report.fills[0].executionTime, '6');
  assert.equal(report.ledger.cash, '798'); assert.equal(report.ledger.quantity, '2');
  assert.equal(report.performance.fees, '2'); assert.equal(report.performance.netPnl, '-4');
});

test('forecast sequences use completed minutes, exact future labels, and purged chronological folds', () => {
  const bars = fixtureBars(300), data = ethForecastData(bars);
  const { samples, schema, contract } = data;
  assert.equal(schema.length, 60 * 6); assert.equal(contract.horizonMs, '300000');
  assert.equal(samples[0].feature.values.length, 360);
  const time = samples[0].time, i = bars.findIndex(bar => bar.availableAt === time);
  assert.equal(samples[0].target, Math.log(Number(bars[i + 5].close) / Number(bars[i].close)));
  assert.equal(samples[0].labelAvailableAt, bars[i + 5].availableAt);
  const prefix = ethForecastData(bars.slice(0, i + 1));
  assert.equal(prefix.samples.length, 0);
  assert.deepEqual(prefix.latest.feature, samples[0].feature);
  assert.equal(data.latest.time, bars.at(-1).availableAt);
  const changed = structuredClone(bars);
  for (const bar of changed.slice(200)) for (const key of ['open', 'high', 'low', 'close']) bar[key] = String(BigInt(bar[key]) * 2n);
  const altered = ethForecastData(changed);
  assert.deepEqual(samples.filter(row => BigInt(row.labelAvailableAt) <= BigInt(bars[199].availableAt)),
    altered.samples.filter(row => BigInt(row.labelAvailableAt) <= BigInt(bars[199].availableAt)));
  assert.throws(() => ethForecastData(bars.filter((_, i) => i !== 150)), { code: 'BAR_GAP' });
  assert.throws(() => ethForecastData([...bars.slice(0, 150), bars[149], ...bars.slice(150)]), { code: 'BAR_GAP' });
  const plan = walkForwardSplits(samples, { trainSize: 100, validationSize: 30, finalStart: 150, stepSize: 200 });
  assert.equal(plan.folds[0].purged.length, 5);
  const train = foldRows(samples, plan, 'fold-1', 'train', 'train');
  assert.ok(train.every(row => BigInt(row.labelAvailableAt) < BigInt(plan.folds[0].validationStart)));
  assert.throws(() => foldRows(samples, plan, 'fold-1', 'train', 'final'), { code: 'PARTITION_DENIED' });
});

test('forecast adapters train, reload, gate availability, and register all trial outcomes',
  { skip: !process.env.ML_PYTHON && 'Set ML_PYTHON to enable optional real PyTorch/LightGBM integration', timeout: 180000 }, async () => {
    const python = process.env.ML_PYTHON, environment = forecastRuntime({ python });
    const runtime = { python, environment };
    const { samples, schema, contract } = ethForecastData(fixtureBars(300), 'synthetic');
    const plan = walkForwardSplits(samples, { trainSize: 100, validationSize: 30, finalStart: 150, stepSize: 200 });
    const rows = foldRows(samples, plan, 'fold-1', 'train', 'train').map(row => ({ ...row, partition: 'train' }));
    const validationRows = foldRows(samples, plan, 'fold-1', 'select', 'validation').map(row => ({ ...row, partition: 'validation' }));
    const options = { rows, validationRows, schema, contract, fold: 'fold-1', cutoff: plan.folds[0].cutoff, seed: 41, runtime };
    const parent = resolve('output'); mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'forecast-test-'));
    try {
      assert.throws(() => fitForecast({ ...options, kind: 'zero', rows: rows.map(row => ({ ...row, partition: 'final' })) }), { code: 'TRAINING_PARTITION' });
      assert.throws(() => fitForecast({ ...options, kind: 'zero', validationRows: [{ ...rows[0], partition: 'validation' }] }), { code: 'EVALUATION_PARTITION' });
      const fitted = {};
      for (const kind of ['zero', 'ridge', 'lightgbm', 'tcn']) {
        const parameters = kind === 'tcn' ? { epochs: 2 } : kind === 'lightgbm' ? { nEstimators: 5 } : {};
        const result = fitForecast({ ...options, kind, parameters });
        fitted[kind] = result.model;
        assert.ok(Number.isFinite(result.validation.mse));
        assert.deepEqual(result.validation.rowIds, validationRows.map(row => row.id));
        if (kind === 'zero') assert.ok(result.validation.predictions.every(value => value === 0));
        if (kind === 'tcn') assert.equal(result.model.diagnostics.receptiveField, 61);
        assert.throws(() => predictForecast({ model: result.model, rows: validationRows, schema, contract, runtime }), { code: 'MODEL_NOT_AVAILABLE' });
      }
      // Validation labels may select weights, but cannot fit either scaler.
      const shifted = fitForecast({ ...options, kind: 'zero', validationRows: validationRows.map(row => ({ ...row, target: row.target + 10 })) });
      assert.deepEqual(shifted.model.preprocessing, fitted.zero.preprocessing);
      assert.deepEqual(shifted.model.targetScaler, fitted.zero.targetScaler);
      const claim = { holdoutId: 'forecast-test', strategyHash: hash(fitted), protocol: { models: Object.keys(fitted) }, samples, plan };
      await withFinalHoldout(join(root, 'holdout'), claim, finalRows => {
        for (const model of Object.values(fitted)) {
          const expected = predictForecast({ model, rows: finalRows, schema, contract, runtime });
          const reloaded = predictForecast({ model: JSON.parse(JSON.stringify(model)), rows: finalRows, schema, contract, runtime });
          assert.deepEqual(expected, reloaded);
          assert.ok(expected.every(row => Number.isFinite(row.predictedReturn) && row.venue === 'synthetic' && row.horizonMs === '300000'));
          if (model.kind === 'zero') assert.ok(expected.every(row => row.predictedReturn === 0));
          assert.throws(() => predictForecast({ model, rows: finalRows, schema, contract,
            runtime: { python, environment: { ...environment, python: 'changed' } } }), { code: 'FORECAST_RUNTIME' });
          const { hash: ignored, ...body } = model;
          const changedBackend = { ...body, backendHash: '0'.repeat(64) };
          assert.throws(() => predictForecast({ model: { ...changedBackend, hash: hash(changedBackend) }, rows: finalRows, schema, contract, runtime }), { code: 'FORECAST_BACKEND_CHANGED' });
          assert.throws(() => predictForecast({ model: { ...model, seed: 42 }, rows: finalRows, schema, contract, runtime }), { code: 'MODEL_ARTIFACT' });
          assert.throws(() => predictForecast({ model, rows: finalRows, schema, contract: { ...contract, venue: 'hyperliquid' }, runtime }), { code: 'FEATURE_SCHEMA' });
        }
        return { models: 4 };
      });
      await assert.rejects(withFinalHoldout(join(root, 'holdout'), claim, () => ({})), { code: 'FINAL_TEST_REUSE' });
      const causal = spawnSync(python, ['-c', [
        'from src.ml.forecast import build_tcn', 'import torch', 'torch.set_num_threads(1)', 'torch.manual_seed(41)',
        'm = build_tcn(16).eval()', 'x = torch.randn(2, 16, 60)', 'y = x.clone()', 'y[:, :, 30:] += 100',
        'assert torch.equal(m.encoder(x)[:, :, :30], m.encoder(y)[:, :, :30])',
        'assert m(x).shape == (2,)', 'assert 24000 < sum(p.numel() for p in m.parameters()) < 25000',
      ].join('\n')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      assert.ifError(causal.error); assert.equal(causal.status, 0, causal.stderr);
      const dependencies = ['experiments/eth-forecast/data.mjs', 'src/ml/forecast.py', 'requirements-ml.txt'];
      for (const kind of ['zero', 'ridge', 'lightgbm', 'tcn', 'failed']) enqueueExperiment(root, { key: `fixture/${kind}`, seed: 41,
        workerModule: new URL('../experiments/eth-forecast/worker.mjs', import.meta.url), dependencies,
        configuration: { kind: kind === 'failed' ? 'tcn' : kind, maxBars: 300, python, environment,
          parameters: kind === 'failed' ? { epochs: 0 } : kind === 'tcn' ? { epochs: 2 } : {} } });
      const jobs = await runQueue(root, { concurrency: 1, timeoutMs: 60000 });
      assert.equal(jobs.filter(job => job.status === 'failed').length, 1);
      const completed = jobs.filter(job => job.status === 'completed'); assert.equal(completed.length, 4, JSON.stringify(jobs));
      const results = completed.map(job => readExperimentResult(root, job.key));
      assert.equal(new Set(results.map(result => result.validationTimesHash)).size, 1);
      assert.equal(new Set(results.map(result => result.dataHash)).size, 1);
      assert.ok(results.every(result => !result.finalReleased));
      for (const job of completed) verifyExperimentArtifacts(root, job.key);
      const artifact = join(completed[0].attempts.at(-1).outputDirectory, 'model.json');
      writeFileSync(artifact, readFileSync(artifact, 'utf8') + ' ');
      assert.throws(() => readExperimentResult(root, completed[0].key), { code: 'ARTIFACT_CHANGED' });
    } finally {
      assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true });
    }
  });
