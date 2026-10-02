import { hash, nat, requireThat } from './core.mjs';
import { featureSchema, validateFeatureArtifact } from './features.mjs';
import { modelReady, trainingAllowed } from './policies.mjs';
import { populationMoments, rootMeanSquare, stableMean } from './numerics.mjs';
import { validatePartition } from './evaluation.mjs';

const finite = (value, name) => {
  requireThat(typeof value === 'number' && Number.isFinite(value), 'NONFINITE_MODEL', `${name} must be a finite number`);
  return value;
};
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const seal = body => freeze({ ...body, hash: hash(body) });
function verifyHash(artifact, format) {
  requireThat(artifact && typeof artifact === 'object' && !Array.isArray(artifact), 'MODEL_ARTIFACT', 'Artifact must be an object');
  const { hash: digest, ...body } = artifact;
  requireThat(artifact.format === format && typeof digest === 'string' && digest === hash(body), 'MODEL_ARTIFACT', 'Artifact format or content hash differs');
}
function identity(schema, fold) {
  requireThat(typeof fold === 'string' && fold.length > 0, 'FOLD_MISMATCH', 'An explicit fold identifier is required');
  return { schema: featureSchema(schema), schemaHash: hash(featureSchema(schema)), fold };
}
function trainingRows(rows, schema, cutoff) {
  nat(cutoff, 'training cutoff');
  requireThat(Array.isArray(rows) && rows.length >= 2, 'TRAINING_DATA', 'At least two explicit training rows are required');
  const ids = new Set();
  let lastLabel = 0n;
  for (const row of rows) {
    requireThat(row && row.partition === 'train', 'TRAINING_PARTITION', 'Fitting accepts only rows explicitly marked train');
    requireThat(typeof row.id === 'string' && row.id.length > 0 && !ids.has(row.id), 'TRAINING_DATA', 'Training IDs must be nonempty and unique'); ids.add(row.id);
    validateFeatureArtifact(row.feature, schema);
    finite(row.target, 'target');
    const label = nat(row.labelAvailableAt, 'labelAvailableAt');
    requireThat(label >= nat(row.feature.time, 'feature.time'), 'TRAINING_AVAILABILITY', 'Label availability precedes observation');
    requireThat(trainingAllowed({ observationTime: row.feature.availableAt, labelAvailableAt: row.labelAvailableAt, cutoff }), 'TRAINING_AVAILABILITY', 'Feature or label was unavailable at training cutoff');
    if (label > lastLabel) lastLabel = label;
  }
  return { lastLabelAvailableAt: String(lastLabel), trainingDataHash: hash(rows.map(row => ({ id: row.id, featureHash: row.feature.hash, target: row.target, labelAvailableAt: row.labelAvailableAt }))) };
}

/** Population standardization fitted only to explicit training rows available strictly before cutoff. */
export function fitStandardScaler({ training, schema }) {
  const { rows, fold, cutoff } = validatePartition(training, 'train');
  const id = identity(schema, fold), data = trainingRows(rows, id.schema, cutoff);
  const moments = id.schema.map((_, col) => populationMoments(rows.map(row => row.feature.values[col])));
  const means = moments.map(value => value.mean), deviations = moments.map(value => value.standardDeviation);
  return seal({ format: 'standard-scaler-v1', featureSchemaHash: id.schemaHash, fold, trainingCutoff: cutoff, trainingPartitionHash: training.hash, ...data, rowCount: rows.length,
    means, scales: deviations.map(value => value === 0 ? 1 : value), zeroVariance: deviations.map(value => value === 0) });
}

export function validateScaler(scaler, schema, fold) {
  const id = identity(schema, fold);
  verifyHash(scaler, 'standard-scaler-v1');
  requireThat(scaler.featureSchemaHash === id.schemaHash, 'FEATURE_SCHEMA', 'Scaler schema differs');
  requireThat(scaler.fold === fold, 'FOLD_MISMATCH', 'Scaler belongs to another fold');
  requireThat(Number.isSafeInteger(scaler.rowCount) && scaler.rowCount >= 2, 'MODEL_ARTIFACT', 'Scaler row count is invalid');
  requireThat(typeof scaler.trainingDataHash === 'string' && /^[0-9a-f]{64}$/.test(scaler.trainingDataHash), 'MODEL_ARTIFACT', 'Training data hash is required');
  requireThat(nat(scaler.lastLabelAvailableAt, 'lastLabelAvailableAt') < nat(scaler.trainingCutoff, 'trainingCutoff'), 'MODEL_ARTIFACT', 'Scaler labels must precede its exclusive cutoff');
  for (const key of ['means', 'scales', 'zeroVariance']) requireThat(Array.isArray(scaler[key]) && scaler[key].length === id.schema.length, 'MODEL_ARTIFACT', 'Scaler dimensions differ');
  for (const value of scaler.means) finite(value, 'scaler mean');
  for (let i = 0; i < scaler.scales.length; i++) { const value = finite(scaler.scales[i], 'scaler scale'); requireThat(value > 0 && typeof scaler.zeroVariance[i] === 'boolean' && (!scaler.zeroVariance[i] || value === 1), 'MODEL_ARTIFACT', 'Invalid scaler scale or zero-variance marker'); }
  return true;
}

export function transformFeatures({ scaler, feature, schema, fold }) {
  validateScaler(scaler, schema, fold); validateFeatureArtifact(feature, schema);
  return feature.values.map((value, col) => finite((value - scaler.means[col]) / scaler.scales[col], 'standardized feature'));
}

// Partial-pivot Gaussian elimination is a deterministic baseline, not a production numerical package.
function solve(matrix, target) {
  const n = target.length, a = matrix.map((row, i) => [...row, target[i]]);
  const scale = Math.max(...matrix.flat().map(Math.abs), 1);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    requireThat(Math.abs(a[pivot][col]) > Number.EPSILON * scale * n * 32, 'DEGENERATE_TRAINING', 'Training design is singular or numerically ill-conditioned; use regularization or remove redundant features');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] = finite(a[col][j] / divisor, 'linear solve');
    for (let row = 0; row < n; row++) if (row !== col) {
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] = finite(a[row][j] - factor * a[col][j], 'linear solve');
    }
  }
  return a.map(row => row[n]);
}

/** Minimizes sum of squared errors + alpha * squared standardized coefficients; intercept is unpenalized. */
export function fitRidge({ training, schema, trainingStartedAt, trainingCompletedAt, deployedAt, alpha = 1, scaler }) {
  const { rows, fold, cutoff } = validatePartition(training, 'train');
  const id = identity(schema, fold), data = trainingRows(rows, id.schema, cutoff);
  finite(alpha, 'ridge alpha'); requireThat(alpha >= 0, 'MODEL_PARAMETER', 'Ridge alpha must be nonnegative');
  requireThat(nat(cutoff, 'cutoff') <= nat(trainingStartedAt, 'trainingStartedAt'), 'TRAINING_AVAILABILITY', 'Training starts before its data cutoff');
  requireThat(modelReady({ labelAvailableAt: data.lastLabelAvailableAt, trainingStartedAt, trainingCompletedAt, deployedAt, decisionTime: deployedAt }), 'MODEL_NOT_AVAILABLE', 'Label, training and deployment chronology is invalid');
  const preprocessing = scaler ?? fitStandardScaler({ training, schema: id.schema });
  validateScaler(preprocessing, id.schema, fold);
  requireThat(preprocessing.trainingPartitionHash === training.hash && preprocessing.trainingCutoff === cutoff && preprocessing.trainingDataHash === data.trainingDataHash, 'PREPROCESSING_DATA', 'Scaler must be fitted on the exact training partition of this model');
  const x = rows.map(row => [1, ...transformFeatures({ scaler: preprocessing, feature: row.feature, schema: id.schema, fold })]);
  const size = id.schema.length + 1;
  const matrix = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => finite(x.reduce((sum, row) => sum + row[i] * row[j], 0) + (i === j && i > 0 ? alpha : 0), 'normal equations')));
  const rhs = Array.from({ length: size }, (_, col) => finite(x.reduce((sum, row, i) => sum + row[col] * rows[i].target, 0), 'normal equations'));
  const [intercept, ...coefficients] = solve(matrix, rhs);
  return seal({ format: 'ridge-model-v1', featureSchemaHash: id.schemaHash, fold, trainingCutoff: cutoff, trainingPartitionHash: training.hash,
    datasetHash: training.datasetHash, planHash: training.planHash, ...data, trainingStartedAt, trainingCompletedAt, deployedAt,
    alpha, intercept, coefficients, preprocessingHash: preprocessing.hash, preprocessing, trainingRowIds: rows.map(row => row.id) });
}

export function validateRidgeModel({ model, schema, fold, decisionTime }) {
  const id = identity(schema, fold);
  verifyHash(model, 'ridge-model-v1');
  requireThat(model.featureSchemaHash === id.schemaHash, 'FEATURE_SCHEMA', 'Model schema differs');
  requireThat(model.fold === fold, 'FOLD_MISMATCH', 'Model belongs to another fold');
  validateScaler(model.preprocessing, id.schema, fold);
  requireThat(model.trainingPartitionHash === model.preprocessing.trainingPartitionHash && model.preprocessingHash === model.preprocessing.hash && model.trainingDataHash === model.preprocessing.trainingDataHash && model.trainingCutoff === model.preprocessing.trainingCutoff && model.lastLabelAvailableAt === model.preprocessing.lastLabelAvailableAt, 'PREPROCESSING_DATA', 'Model and scaler lineage differ');
  requireThat(nat(model.trainingCutoff, 'trainingCutoff') <= nat(model.trainingStartedAt, 'trainingStartedAt'), 'MODEL_NOT_AVAILABLE', 'Training precedes cutoff');
  requireThat(modelReady({ labelAvailableAt: model.lastLabelAvailableAt, trainingStartedAt: model.trainingStartedAt, trainingCompletedAt: model.trainingCompletedAt, deployedAt: model.deployedAt, decisionTime }), 'MODEL_NOT_AVAILABLE', 'Model training or deployment is unavailable at decision time');
  requireThat(Array.isArray(model.coefficients) && model.coefficients.length === id.schema.length, 'MODEL_ARTIFACT', 'Model coefficient dimensions differ');
  finite(model.intercept, 'intercept'); for (const value of model.coefficients) finite(value, 'coefficient');
  finite(model.alpha, 'ridge alpha'); requireThat(model.alpha >= 0, 'MODEL_ARTIFACT', 'Invalid ridge regularization');
  requireThat(Array.isArray(model.trainingRowIds) && model.trainingRowIds.length === model.preprocessing.rowCount && new Set(model.trainingRowIds).size === model.trainingRowIds.length && Array.from(model.trainingRowIds).every(value => typeof value === 'string' && value.length > 0), 'MODEL_ARTIFACT', 'Model training row IDs are invalid');
  return true;
}

export function predictRidge({ model, feature, schema, fold, decisionTime }) {
  validateRidgeModel({ model, schema, fold, decisionTime }); validateFeatureArtifact(feature, schema);
  requireThat(nat(feature.availableAt, 'feature.availableAt') <= nat(decisionTime, 'decisionTime'), 'FEATURE_AVAILABILITY', 'Prediction feature was unavailable at decision time');
  const values = transformFeatures({ scaler: model.preprocessing, feature, schema, fold });
  const prediction = finite(values.reduce((sum, value, col) => sum + value * model.coefficients[col], model.intercept), 'prediction');
  return seal({ format: 'ridge-prediction-v1', modelHash: model.hash, preprocessingHash: model.preprocessingHash, featureHash: feature.hash, featureSchemaHash: model.featureSchemaHash, fold, decisionTime, prediction });
}

/** Evaluates already-fitted parameters on a separately named partition; it never fits or selects a model. */
export function evaluateRegression({ model, rows, schema, fold, partition }) {
  requireThat(['validation', 'final'].includes(partition), 'EVALUATION_PARTITION', 'Evaluation requires validation or final partition');
  requireThat(Array.isArray(rows) && rows.length > 0, 'EVALUATION_DATA', 'Evaluation rows are required');
  validateRidgeModel({ model, schema, fold, decisionTime: rows[0]?.decisionTime });
  const trainingIds = new Set(model.trainingRowIds), ids = new Set();
  const predictions = rows.map(row => {
    requireThat(row && row.partition === partition && typeof row.id === 'string' && row.id.length > 0 && !ids.has(row.id) && !trainingIds.has(row.id), 'EVALUATION_PARTITION', 'Evaluation IDs must be unique, held out, and in the requested partition'); ids.add(row.id);
    finite(row.target, 'evaluation target');
    requireThat(nat(row.labelAvailableAt, 'labelAvailableAt') >= nat(row.feature.time, 'feature.time'), 'EVALUATION_DATA', 'Evaluation label precedes observation');
    requireThat(nat(row.feature.time, 'feature.time') >= nat(model.trainingCutoff, 'trainingCutoff'), 'EVALUATION_PARTITION', 'Evaluation observations must be at or after the exclusive training cutoff');
    return predictRidge({ model, feature: row.feature, schema, fold, decisionTime: row.decisionTime });
  });
  const metrics = regressionMetrics(predictions.map(prediction => prediction.prediction), rows.map(row => row.target));
  return seal({ format: 'regression-evaluation-v1', modelHash: model.hash, fold, partition, rowCount: rows.length, ...metrics,
    evaluationDataHash: hash(rows.map(row => ({ id: row.id, featureHash: row.feature.hash, target: row.target, labelAvailableAt: row.labelAvailableAt, decisionTime: row.decisionTime }))), predictions });
}

/** Numerical forecast errors only; callers enforce partition and model lineage. */
export function regressionMetrics(predictions, targets) {
  requireThat(Array.isArray(predictions) && predictions.length > 0 && Array.isArray(targets) && predictions.length === targets.length, 'EVALUATION_DATA', 'Nonempty aligned predictions and targets required');
  const errors = predictions.map((prediction, i) => finite(finite(prediction, 'prediction') - finite(targets[i], 'target'), 'prediction error'));
  const rmse = rootMeanSquare(errors), squared = rmse * rmse;
  const mseUnavailableReason = !Number.isFinite(squared) ? 'overflow' : squared === 0 && rmse !== 0 ? 'underflow' : null;
  const mse = mseUnavailableReason === null ? squared : null;
  const mae = stableMean(errors.map(Math.abs));
  return { mse, mseUnavailableReason, rmse, mae };
}
