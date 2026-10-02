import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hash, nat, requireThat } from './framework.mjs';
import { featureSchema, validateFeatureArtifact } from './features.mjs';
import { fitStandardScaler, validateScaler, regressionMetrics } from './models.mjs';
import { populationMoments } from './numerics.mjs';

const backendPath = fileURLToPath(new URL('./ml/forecast.py', import.meta.url));
const backendHash = () => hash(readFileSync(backendPath, 'utf8'));
const seal = body => ({ ...body, hash: hash(body) });
function backend(request, { python = process.env.ML_PYTHON || 'python', timeoutMs = 120000, environment } = {}) {
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'FORECAST_RUNTIME', 'Positive subprocess timeout required');
  requireThat(!request.expectedRuntime || !environment || hash(request.expectedRuntime) === hash(environment), 'FORECAST_RUNTIME', 'Requested runtime differs from the fitted artifact');
  const result = spawnSync(python, [backendPath], { input: JSON.stringify({ ...request, ...(environment ? { expectedRuntime: environment } : {}) }), encoding: 'utf8', timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } });
  requireThat(!result.error && result.status === 0, 'FORECAST_BACKEND', `Python forecast failed: ${result.error?.message || result.stderr}. Install requirements-ml.txt and set ML_PYTHON.`);
  return JSON.parse(result.stdout);
}

/** Record this before enqueueing so a changed Python environment changes the job identity. */
export function forecastRuntime(runtime) { return backend({ operation: 'runtime' }, runtime); }

function contractCheck(contract, schema) {
  requireThat(contract && ['instrument', 'venue'].every(key => typeof contract[key] === 'string' && contract[key].length), 'FORECAST_TARGET', 'Explicit target instrument and venue required');
  requireThat(Number.isSafeInteger(contract.sequenceLength) && contract.sequenceLength > 0 && Number.isSafeInteger(contract.featureCount) && contract.featureCount > 0 &&
    schema.length === contract.sequenceLength * contract.featureCount, 'FORECAST_SHAPE', 'Sequence shape differs from feature schema');
  requireThat(contract.target === 'log-close-return', 'FORECAST_TARGET', 'Only log-close-return targets are supported');
  nat(contract.horizonMs, 'horizonMs', true); nat(contract.intervalMs, 'intervalMs', true);
}

function matrix(rows, schema, scaler) {
  return rows.map(row => {
    validateFeatureArtifact(row.feature, schema);
    const values = row.feature.values.map((value, i) => (value - scaler.means[i]) / scaler.scales[i]);
    requireThat(values.every(Number.isFinite), 'NONFINITE_MODEL', 'Nonfinite standardized features');
    return values;
  });
}

/** Fit on explicit train rows; validation is used only for model selection.
 * Validation predictions are retrospective diagnostics, not executable signals.
 * Portable JSON artifacts retain weights, preprocessing, lineage and runtime. */
export function fitForecast({ kind, rows, validationRows, schema, contract, fold, cutoff, seed = 1, parameters = {}, runtime }) {
  requireThat(['zero', 'ridge', 'lightgbm', 'tcn'].includes(kind), 'FORECAST_KIND', 'Unknown forecast adapter');
  schema = featureSchema(schema); contractCheck(contract, schema);
  requireThat(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'MODEL_PARAMETER', 'Seed must be uint32');
  const preprocessing = fitStandardScaler({ rows, schema, fold, cutoff });
  requireThat(Array.isArray(validationRows) && validationRows.length > 0, 'EVALUATION_DATA', 'Later validation rows required');
  const ids = new Set(rows.map(row => row.id)); let last = null, selectedThrough = 0n;
  for (const row of validationRows) {
    requireThat(row.partition === 'validation' && typeof row.id === 'string' && row.id.length > 0 && !ids.has(row.id), 'EVALUATION_PARTITION', 'Unique held-out validation rows required'); ids.add(row.id);
    const time = nat(row.time, 'validation time'), label = nat(row.labelAvailableAt, 'labelAvailableAt');
    requireThat(time >= nat(cutoff, 'cutoff') && (last === null || time > last) && row.feature.time === row.time &&
      nat(row.feature.availableAt, 'availableAt') <= time && label === time + BigInt(contract.horizonMs), 'FORECAST_CHRONOLOGY', 'Invalid validation chronology or label horizon');
    requireThat(Number.isFinite(row.target), 'NONFINITE_MODEL', 'Finite target required');
    last = time; selectedThrough = label > selectedThrough ? label : selectedThrough;
  }
  let previous = null;
  for (const row of rows) {
    const time = nat(row.time, 'training time');
    requireThat(row.feature.time === row.time && nat(row.feature.availableAt, 'availableAt') <= time &&
      (previous === null || time > previous) && BigInt(row.labelAvailableAt) === time + BigInt(contract.horizonMs), 'FORECAST_CHRONOLOGY', 'Training chronology or label horizon differs');
    previous = time;
  }
  const moments = populationMoments(rows.map(row => row.target));
  const targetScaler = { mean: moments.mean, scale: moments.standardDeviation || 1 };
  const sourceHash = backendHash();
  const result = backend({ operation: 'fit', kind, seed, parameters, contract, x: matrix(rows, schema, preprocessing),
    y: rows.map(row => (row.target - targetScaler.mean) / targetScaler.scale), validationX: matrix(validationRows, schema, preprocessing),
    validationY: validationRows.map(row => (row.target - targetScaler.mean) / targetScaler.scale),
    zero: -targetScaler.mean / targetScaler.scale }, runtime);
  requireThat(sourceHash === backendHash(), 'FORECAST_BACKEND_CHANGED', 'Python implementation changed during fitting');
  const model = seal({ format: 'forecast-model-v1', kind, contract, schema, fold, cutoff, seed, parameters: result.parameters,
    preprocessing, targetScaler, trainingRowIds: rows.map(row => row.id), selectionRowIds: validationRows.map(row => row.id),
    selectionDataHash: hash(validationRows), selectedThrough: String(selectedThrough), availableAt: String(selectedThrough + 1n),
    backendHash: sourceHash, runtime: result.runtime, state: result.state, diagnostics: result.diagnostics });
  const predictions = returns(result.predictions, targetScaler, validationRows.length);
  if (kind === 'zero') predictions.fill(0); // Preserve the exact baseline through inverse scaling.
  const metrics = regressionMetrics(predictions, validationRows.map(row => row.target));
  return { model, validation: { scope: 'retrospective validation selection; not tradable forecasts', partition: 'validation',
    modelHash: model.hash, evaluationDataHash: model.selectionDataHash, rowIds: validationRows.map(row => row.id), predictions, ...metrics } };
}

function returns(predictions, scaler, count) {
  requireThat(Array.isArray(predictions) && predictions.length === count, 'FORECAST_OUTPUT', 'Prediction count differs');
  return predictions.map(value => {
    const result = value * scaler.scale + scaler.mean;
    requireThat(Number.isFinite(value) && Number.isFinite(result), 'FORECAST_OUTPUT', 'Nonfinite prediction');
    return result === 0 ? 0 : result;
  });
}

/** Batch inference from saved weights; never fits. Final evaluation callers must
 * obtain rows through withFinalHoldout. Instrument/venue are bound to the model. */
export function predictForecast({ model, rows, schema, contract, runtime }) {
  const { hash: digest, ...body } = model;
  requireThat(model.format === 'forecast-model-v1' && digest === hash(body), 'MODEL_ARTIFACT', 'Forecast artifact changed');
  requireThat(model.backendHash === backendHash(), 'FORECAST_BACKEND_CHANGED', 'Python implementation differs from the fitted artifact');
  requireThat(hash(featureSchema(schema)) === hash(model.schema) && hash(contract) === hash(model.contract), 'FEATURE_SCHEMA', 'Forecast schema or target contract differs');
  contractCheck(contract, schema); validateScaler(model.preprocessing, schema, model.fold);
  requireThat(Array.isArray(rows) && rows.length > 0, 'FORECAST_INPUT', 'Prediction rows required');
  for (const row of rows) requireThat(nat(row.time, 'forecast time') >= nat(model.availableAt, 'model availableAt') &&
    row.feature.time === row.time && nat(row.feature.availableAt, 'feature availableAt') <= BigInt(row.time), 'MODEL_NOT_AVAILABLE', 'Selected model or feature unavailable at forecast time');
  const result = backend({ operation: 'predict', kind: model.kind, contract, state: model.state, expectedRuntime: model.runtime,
    x: matrix(rows, schema, model.preprocessing) }, runtime);
  requireThat(model.backendHash === backendHash(), 'FORECAST_BACKEND_CHANGED', 'Python implementation changed during prediction');
  return returns(result.predictions, model.targetScaler, rows.length).map((predictedReturn, i) => seal({ format: 'return-forecast-v1',
    instrument: contract.instrument, venue: contract.venue, time: rows[i].time, horizonMs: contract.horizonMs,
    predictedReturn: model.kind === 'zero' ? 0 : predictedReturn, modelHash: model.hash, featureHash: rows[i].feature.hash }));
}
