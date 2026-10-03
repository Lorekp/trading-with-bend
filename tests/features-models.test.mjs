import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../src/core.mjs';
import { RollingFeatures, featureSchema, computeFeatures, validateFeatureArtifact } from '../src/features.mjs';
import { fitStandardScaler, transformFeatures, fitRidge, validateRidgeModel, predictRidge, evaluateRegression } from '../src/models.mjs';
import { stableMean, populationMoments, rootMeanSquare } from '../src/numerics.mjs';
import { trainingWindow, evaluationWindow } from '../src/evaluation.mjs';

const schema = [{ name: 'price', source: 'price', kind: 'value', unit: 'ticks' }];
const observation = (time, price, availableAt = time) => ({ time: String(time), availableAt: String(availableAt), values: { price } });
const feature = (time, price, availableAt = time) => computeFeatures([observation(time, price, availableAt)], schema)[0];
const trainRows = (prices = [1, 2, 3], target = x => 2 * x + 1) => prices.map((price, i) => ({ id: `train-${i}`, partition: 'train', feature: feature(i + 1, price), target: target(price), labelAvailableAt: String(i + 1) }));
const fit = (extra = {}) => {
  const { rows = trainRows(), fold = 'fold-1', cutoff = '4', ...options } = extra;
  return fitRidge({ training: trainingWindow(rows, { fold, cutoff }), schema, trainingStartedAt: '4', trainingCompletedAt: '5', deployedAt: '6', alpha: 0, ...options });
};
const code = expected => error => error.code === expected;
const near = (actual, expected, epsilon = 1e-10) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} differs from ${expected}`);
const rehash = artifact => { const { hash: ignored, ...body } = artifact; return { ...body, hash: hash(body) }; };

test('trailing rolling features have analytic values, explicit warmup, and batch/stream parity', () => {
  const definitions = [
    ...schema,
    { name: 'lagged', source: 'price', kind: 'lag', lag: 1, unit: 'ticks' },
    { name: 'average', source: 'price', kind: 'mean', window: 3, unit: 'ticks' },
    { name: 'volatility', source: 'price', kind: 'std', window: 3, unit: 'ticks' },
    { name: 'return', source: 'price', kind: 'return', lag: 2, unit: 'fraction' },
  ];
  const rows = [observation(1, 2), observation(2, 4), observation(3, 6), observation(4, 8)];
  const batch = computeFeatures(rows, definitions), stream = new RollingFeatures(definitions);
  assert.deepEqual(batch, rows.map(row => stream.update(row)));
  assert.deepEqual(batch[0].values, [2, null, null, null, null]); assert.equal(batch[0].ready, false);
  assert.deepEqual(batch[1].values, [4, 2, null, null, null]);
  const [value, lag, mean, std, ret] = batch[2].values;
  assert.equal(value, 6); assert.equal(lag, 4); assert.equal(mean, 4); near(std, Math.sqrt(8 / 3)); assert.equal(ret, 2);
  assert.equal(batch[2].ready, true); assert.equal(batch[3].values[2], 6);
  assert.equal(validateFeatureArtifact(batch[2], definitions), true);
  assert.throws(() => validateFeatureArtifact(batch[0], definitions), code('FEATURE_WARMUP'));
  assert.equal(validateFeatureArtifact(batch[0], definitions, { allowWarmup: true }), true);
});

test('appending any future suffix preserves every earlier feature and hash', () => {
  const definitions = [{ name: 'average', source: 'price', kind: 'mean', window: 2, unit: 'ticks' }];
  const prefix = [observation(1, 2), observation(2, 4), observation(3, 6)];
  const a = computeFeatures(prefix, definitions), b = computeFeatures([...prefix, observation(4, 1e12), observation(5, -1e12)], definitions);
  assert.deepEqual(a, b.slice(0, prefix.length));
});

test('feature schema identity binds order, names, units, lag and trailing window definitions', () => {
  const definitions = [...schema, { name: 'average', source: 'price', kind: 'mean', window: 1, unit: 'ticks' }];
  const value = computeFeatures([observation(1, 2)], definitions)[0];
  for (const changed of [[...definitions].reverse(), definitions.map(entry => ({ ...entry, unit: 'EUR' })), [schema[0], { ...definitions[1], window: 2 }]]) assert.throws(() => validateFeatureArtifact(value, changed), code('FEATURE_SCHEMA'));
  assert.throws(() => featureSchema([{ ...schema[0], centered: true }]), code('FEATURE_SCHEMA'));
  assert.throws(() => featureSchema([{ name: 'future', source: 'price', kind: 'lag', lag: -1, unit: 'ticks' }]), code('FEATURE_SCHEMA'));
  assert.throws(() => featureSchema([schema[0], schema[0]]), code('FEATURE_SCHEMA'));
  assert.throws(() => featureSchema(new Array(1)), code('FEATURE_SCHEMA'));
});

test('missing/nonfinite sources, zero return denominators, and out-of-order data fail atomically', () => {
  const stream = new RollingFeatures(schema); stream.update(observation(1, 1));
  for (const invalid of [NaN, Infinity, -Infinity, null, undefined, '2']) assert.throws(() => stream.update(observation(2, invalid)), code('NONFINITE_FEATURE'));
  assert.deepEqual(stream.update(observation(2, 2)).values, [2]);
  assert.throws(() => stream.update(observation(2, 3)), code('FEATURE_ORDER'));
  assert.throws(() => stream.update(observation(4, 3, 3)), code('FEATURE_AVAILABILITY'));
  const delayed = new RollingFeatures(schema); delayed.update(observation(1, 1, 10));
  assert.throws(() => delayed.update(observation(2, 2, 9)), code('FEATURE_ORDER'));
  const returns = new RollingFeatures([{ name: 'return', source: 'price', kind: 'return', lag: 1, unit: 'fraction' }]);
  returns.update(observation(1, 0)); assert.throws(() => returns.update(observation(2, 2)), code('FEATURE_DIVISION'));
});

test('feature artifacts are immutable, JSON round-trip stable and detect content tampering', () => {
  const value = feature(1, 2);
  assert.throws(() => { value.values[0] = 99; }, TypeError);
  assert.equal(validateFeatureArtifact(JSON.parse(JSON.stringify(value)), schema), true);
  const corrupt = structuredClone(value); corrupt.values[0] = 99;
  assert.throws(() => validateFeatureArtifact(corrupt, schema), code('FEATURE_ARTIFACT'));
  assert.throws(() => validateFeatureArtifact(rehash({ ...value, ready: false }), schema), code('FEATURE_ARTIFACT'));
});

test('scaler uses training-only population mean/std and preserves zero-variance columns', () => {
  const scaler = fitStandardScaler({ training: trainingWindow(trainRows(), { fold: 'fold-1', cutoff: '4' }), schema });
  assert.deepEqual(scaler.means, [2]); near(scaler.scales[0], Math.sqrt(2 / 3));
  const result = transformFeatures({ scaler, feature: feature(10, 100), schema, fold: 'fold-1' });
  near(result[0], 98 / Math.sqrt(2 / 3)); assert.deepEqual(scaler.means, [2]);
  const zero = fitStandardScaler({ training: trainingWindow(trainRows([3, 3, 3]), { fold: 'fold-1', cutoff: '4' }), schema });
  assert.deepEqual(zero.zeroVariance, [true]); assert.deepEqual(zero.scales, [1]);
  assert.deepEqual(transformFeatures({ scaler: zero, feature: feature(10, 3), schema, fold: 'fold-1' }), [0]);
});

test('fit rejects validation/final rows, duplicate rows and unavailable labels or features', () => {
  for (const partition of ['validation', 'final', undefined]) {
    const rows = trainRows(); rows[1].partition = partition;
    assert.throws(() => fit({ rows }), code('TRAINING_PARTITION'));
  }
  let rows = trainRows(); rows[1].id = rows[0].id;
  assert.throws(() => fit({ rows }), code('TRAINING_DATA'));
  rows = trainRows(); rows[1].labelAvailableAt = '5';
  assert.throws(() => fit({ rows }), code('TRAINING_AVAILABILITY'));
  rows = trainRows(); rows[1].labelAvailableAt = '4';
  assert.throws(() => fit({ rows }), code('TRAINING_AVAILABILITY'));
  rows = trainRows(); rows[1].feature = feature(2, 2, 5);
  assert.throws(() => fit({ rows }), code('TRAINING_AVAILABILITY'));
  assert.throws(() => fit({ rows: trainRows().slice(0, 1) }), code('TRAINING_DATA'));
  assert.throws(() => fit({ trainingStartedAt: '3' }), code('TRAINING_AVAILABILITY'));
});

test('ordinary least squares matches analytic affine data and predictions preserve lineage', () => {
  const model = fit(), prediction = predictRidge({ model, feature: feature(7, 4), schema, fold: 'fold-1', decisionTime: '7' });
  near(model.intercept, 5); near(model.coefficients[0], 2 * Math.sqrt(2 / 3)); near(prediction.prediction, 9);
  assert.equal(prediction.modelHash, model.hash); assert.equal(prediction.preprocessingHash, model.preprocessing.hash);
  assert.deepEqual(fit(), model);
  assert.deepEqual(predictRidge({ model: JSON.parse(JSON.stringify(model)), feature: feature(7, 4), schema, fold: 'fold-1', decisionTime: '7' }), prediction);
});

test('ridge has analytic coefficient shrinkage with an unpenalized intercept', () => {
  const model = fit({ alpha: 3 });
  near(model.intercept, 5); near(model.coefficients[0], Math.sqrt(2 / 3));
  near(predictRidge({ model, feature: feature(7, 4), schema, fold: 'fold-1', decisionTime: '7' }).prediction, 7);
});

test('multivariate OLS recovers independent known coefficients and held-out combinations', () => {
  const definitions = [
    { name: 'x', source: 'x', kind: 'value', unit: 'arbitrary' },
    { name: 'z', source: 'z', kind: 'value', unit: 'arbitrary' },
  ];
  const inputs = [[1, 1], [1, 2], [2, 1], [2, 3], [4, 2], [5, 4]];
  const featureRows = computeFeatures(inputs.map(([x, z], i) => ({ time: String(i + 1), availableAt: String(i + 1), values: { x, z } })), definitions);
  const rows = featureRows.map((entry, i) => ({ id: `multi-${i}`, partition: 'train', feature: entry, target: 7 + 2 * inputs[i][0] - 3 * inputs[i][1], labelAvailableAt: String(i + 1) }));
  const model = fitRidge({ training: trainingWindow(rows, { fold: 'multi', cutoff: '7' }), schema: definitions, trainingStartedAt: '7', trainingCompletedAt: '8', deployedAt: '9', alpha: 0 });
  near(model.coefficients[0] / model.preprocessing.scales[0], 2); near(model.coefficients[1] / model.preprocessing.scales[1], -3);
  for (const [x, z] of [[-4, 8], [10, -2], [0, 0]]) {
    const entry = computeFeatures([{ time: '10', availableAt: '10', values: { x, z } }], definitions)[0];
    near(predictRidge({ model, feature: entry, schema: definitions, fold: 'multi', decisionTime: '10' }).prediction, 7 + 2 * x - 3 * z);
  }
});

test('degenerate OLS fails explicitly while ridge handles constant and collinear features', () => {
  assert.throws(() => fit({ rows: trainRows([3, 3, 3]), alpha: 0 }), code('DEGENERATE_TRAINING'));
  const model = fit({ rows: trainRows([3, 3, 3]), alpha: 1 });
  near(model.intercept, 7); near(model.coefficients[0], 0);
  const doubled = [...schema, { name: 'same-price', source: 'price', kind: 'value', unit: 'ticks' }];
  const rows = trainRows().map((row, i) => ({ ...row, feature: computeFeatures([observation(i + 1, i + 1)], doubled)[0] }));
  assert.throws(() => fit({ schema: doubled, rows, alpha: 0 }), code('DEGENERATE_TRAINING'));
  assert.ok(fit({ schema: doubled, rows, alpha: 1 }).coefficients.every(Number.isFinite));
});

test('scaler reuse binds schema, fold and exact training data, including cutoff', () => {
  const scaler = fitStandardScaler({ training: trainingWindow(trainRows(), { fold: 'fold-1', cutoff: '4' }), schema });
  assert.deepEqual(fit({ scaler }), fit());
  assert.throws(() => fit({ scaler, fold: 'fold-2' }), code('FOLD_MISMATCH'));
  assert.throws(() => fit({ scaler, rows: trainRows([1, 2, 4]) }), code('PREPROCESSING_DATA'));
  assert.throws(() => fit({ scaler, cutoff: '5', trainingStartedAt: '5' }), code('PREPROCESSING_DATA'));
  const changed = [{ ...schema[0], unit: 'EUR' }];
  assert.throws(() => transformFeatures({ scaler, feature: feature(7, 4), schema: changed, fold: 'fold-1' }), code('FEATURE_SCHEMA'));
});

test('prediction rejects pre-deployment decisions, unavailable features, wrong folds and tampering', () => {
  const model = fit(), args = { model, feature: feature(7, 4), schema, fold: 'fold-1', decisionTime: '7' };
  assert.throws(() => predictRidge({ ...args, decisionTime: '5' }), code('MODEL_NOT_AVAILABLE'));
  assert.throws(() => predictRidge({ ...args, feature: feature(7, 4, 8) }), code('FEATURE_AVAILABILITY'));
  assert.throws(() => predictRidge({ ...args, fold: 'fold-2' }), code('FOLD_MISMATCH'));
  const corrupt = structuredClone(model); corrupt.intercept++;
  assert.throws(() => predictRidge({ ...args, model: corrupt }), code('MODEL_ARTIFACT'));
  const corruptScaler = structuredClone(model); corruptScaler.preprocessing.means[0]++;
  assert.throws(() => validateRidgeModel({ ...args, model: rehash(corruptScaler) }), code('MODEL_ARTIFACT'));
  assert.throws(() => fit({ trainingCompletedAt: '7', deployedAt: '6' }), code('MODEL_NOT_AVAILABLE'));
});

test('held-out evaluation matches independent analytic errors without changing parameters', () => {
  const model = fit(), before = JSON.stringify(model);
  const rows = [4, 5].map((price, i) => ({ id: `validation-${i}`, partition: 'validation', feature: feature(i + 7, price), decisionTime: String(i + 7), target: 2 * price + 2, labelAvailableAt: String(i + 8) }));
  const training = trainingWindow(trainRows(), { fold: 'fold-1', cutoff: '4' });
  const evaluate = rows => evaluateRegression({ model, evaluation: evaluationWindow(rows, { training }), schema });
  const result = evaluate(rows);
  near(result.mse, 1); near(result.rmse, 1); near(result.mae, 1);
  assert.equal(JSON.stringify(model), before); assert.equal(result.predictions.length, 2);
  assert.equal(result.evaluationPartitionHash, evaluationWindow(rows, { training }).hash);
  assert.equal(result.planHash, null);
  assert.throws(() => evaluate(trainRows().map(row => ({ ...row, decisionTime: '7' }))), code('EVALUATION_PARTITION'));
  assert.throws(() => evaluate([{ ...rows[0], id: 'train-0' }]), code('EVALUATION_PARTITION'));
  assert.throws(() => evaluate([{ ...rows[0], feature: feature(3, 4) }]), code('EVALUATION_PARTITION'));
  assert.throws(() => evaluate(rows.map(row => ({ ...row, partition: 'final' }))), code('EVALUATION_PARTITION'));
  assert.throws(() => evaluate([rows[0], rows[0]]), code('EVALUATION_PARTITION'));
  assert.throws(() => evaluate([{ ...rows[0], decisionTime: '5' }]), code('MODEL_NOT_AVAILABLE'));
  assert.throws(() => evaluate([{ ...rows[0], feature: feature(7, 4, 8) }]), code('FEATURE_AVAILABILITY'));
  const otherTraining = trainingWindow(trainRows([1, 2, 4]), { fold: 'fold-1', cutoff: '4' });
  assert.throws(() => evaluateRegression({ model, evaluation: evaluationWindow(rows, { training: otherTraining }), schema }), code('EVALUATION_PARTITION'));
  assert.deepEqual(evaluate(rows.map(({ decisionTime, ...row }) => row)).predictions, result.predictions);
});

test('nonfinite targets, overflowed features and ill-conditioned arithmetic reject explicitly', () => {
  for (const target of [NaN, Infinity, '2']) {
    const rows = trainRows(); rows[0].target = target;
    assert.throws(() => fit({ rows }), code('NONFINITE_MODEL'));
  }
  assert.throws(() => fit({ alpha: -1 }), code('MODEL_PARAMETER'));
  assert.throws(() => fit({ rows: trainRows([1e308, -1e308, 1e308]) }), code('NONFINITE_MODEL'));
  const stream = new RollingFeatures([{ name: 'std', source: 'price', kind: 'std', window: 2, unit: 'ticks' }]);
  stream.update(observation(1, 0));
  assert.throws(() => stream.update(observation(2, Number.MIN_VALUE)), code('NUMERICAL_UNDERFLOW'));
  assert.deepEqual(stream.update(observation(2, 0)).values, [0]);
});

const relativeNear = (actual, expected, tolerance = 1e-14) => assert.ok(Math.abs(actual / expected - 1) <= tolerance, `${actual} differs from ${expected}`);

test('six identical values remain exactly constant in rolling features and standardization', () => {
  const definitions = [
    { name: 'mean', source: 'price', kind: 'mean', window: 6, unit: 'ticks' },
    { name: 'std', source: 'price', kind: 'std', window: 6, unit: 'ticks' },
  ];
  const observations = Array.from({ length: 6 }, (_, i) => observation(i + 1, 1));
  assert.deepEqual(computeFeatures(observations, definitions).at(-1).values, [1, 0]);
  const scaler = fitStandardScaler({ training: trainingWindow(trainRows(Array(6).fill(1)), { fold: 'constant', cutoff: '7' }), schema });
  assert.deepEqual(scaler.means, [1]); assert.deepEqual(scaler.scales, [1]); assert.deepEqual(scaler.zeroVariance, [true]);
  assert.deepEqual(transformFeatures({ scaler, feature: feature(8, 1), schema, fold: 'constant' }), [0]);
});

test('tiny and large finite variation yields meaningful moments and normalized features', () => {
  const definitions = [
    { name: 'mean', source: 'price', kind: 'mean', window: 2, unit: 'ticks' },
    { name: 'std', source: 'price', kind: 'std', window: 2, unit: 'ticks' },
  ];
  for (const magnitude of [1e-200, 1e200]) {
    const [mean, std] = computeFeatures([observation(1, magnitude), observation(2, 2 * magnitude)], definitions).at(-1).values;
    relativeNear(mean, 1.5 * magnitude); relativeNear(std, 0.5 * magnitude);
    const scaler = fitStandardScaler({ training: trainingWindow(trainRows([magnitude, 2 * magnitude], () => 0), { fold: 'scale', cutoff: '3' }), schema });
    assert.deepEqual(scaler.zeroVariance, [false]); relativeNear(scaler.scales[0], 0.5 * magnitude);
    near(transformFeatures({ scaler, feature: feature(8, magnitude), schema, fold: 'scale' })[0], -1);
    near(transformFeatures({ scaler, feature: feature(8, 2 * magnitude), schema, fold: 'scale' })[0], 1);
    const model = fit({ rows: trainRows([magnitude, 2 * magnitude, 3 * magnitude], value => value / magnitude), alpha: 0 });
    near(predictRidge({ model, feature: feature(7, 4 * magnitude), schema, fold: 'fold-1', decisionTime: '7' }).prediction, 4);
  }
  assert.equal(populationMoments([1e16, 1e16 + 2]).standardDeviation, 1);
  const extremes = computeFeatures([observation(1, 1e308), observation(2, -1e308)], definitions).at(-1).values;
  assert.equal(extremes[0], 0); relativeNear(extremes[1], 1e308);
  assert.equal(stableMean([1e308, 1e308]), 1e308);
  relativeNear(stableMean([1e308, -1e308, 1e-200]), 1e-200 / 3);
});

test('unrepresentable nonzero moments fail explicitly instead of becoming zero', () => {
  assert.throws(() => stableMean([Number.MIN_VALUE, 0]), code('NUMERICAL_UNDERFLOW'));
  assert.throws(() => populationMoments([Number.MIN_VALUE, Number.MIN_VALUE, 0]), code('NUMERICAL_UNDERFLOW'));
  assert.throws(() => rootMeanSquare([Number.MIN_VALUE, ...Array(9).fill(0)]), code('NUMERICAL_UNDERFLOW'));
  assert.throws(() => fitStandardScaler({ training: trainingWindow(trainRows([0, Number.MIN_VALUE], () => 0), { fold: 'subnormal', cutoff: '3' }), schema }), code('NUMERICAL_UNDERFLOW'));
  assert.throws(() => stableMean([Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE, 1e-15]), code('NUMERICAL_UNDERFLOW'));
});

test('evaluation preserves representable RMSE and explicitly marks unavailable squared metrics', () => {
  const training = trainingWindow(trainRows([1, 2, 3], () => 0), { fold: 'fold-1', cutoff: '4' });
  const model = fit({ training, alpha: 1 });
  for (const [magnitude, reason] of [[1e-200, 'underflow'], [1e200, 'overflow'], [1e-160, null], [0, null]]) {
    const rows = [1, -1].map((sign, i) => ({ id: `held-${i}`, partition: 'validation', feature: feature(i + 7, 4 + i), decisionTime: String(i + 7), target: sign * magnitude, labelAvailableAt: String(i + 8) }));
    const result = evaluateRegression({ model, evaluation: evaluationWindow(rows, { training }), schema });
    assert.equal(result.mseUnavailableReason, reason);
    if (reason) assert.equal(result.mse, null); else assert.equal(result.mse, magnitude * magnitude);
    if (magnitude === 0) { assert.equal(result.rmse, 0); assert.equal(result.mae, 0); }
    else { relativeNear(result.rmse, magnitude); relativeNear(result.mae, magnitude); }
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});
