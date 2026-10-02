import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, json, nat, requireThat } from './framework.mjs';
import { trainingAllowed, canReadPartition } from './policies.mjs';

const frozenCopy = value => {
  const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
  return freeze(structuredClone(value));
};
const count = (value, name, minimum = 1) => requireThat(Number.isSafeInteger(value) && value >= minimum, 'SPLIT_ARGUMENT', `${name} must be an integer >= ${minimum}`);

/** Chronological walk-forward folds. Purge actual label availability, then embargo. */
export function walkForwardSplits(samples, { trainSize, validationSize, stepSize = validationSize, embargoMs = '0', expanding = false, finalStart = samples?.length } = {}) {
  requireThat(Array.isArray(samples), 'SPLIT_INPUT', 'samples must be an array');
  count(trainSize, 'trainSize'); count(validationSize, 'validationSize'); count(stepSize, 'stepSize'); count(finalStart, 'finalStart', 0);
  requireThat(stepSize >= validationSize && finalStart <= samples.length && typeof expanding === 'boolean', 'SPLIT_ARGUMENT', 'Validation windows must not overlap; finalStart must be inside the dataset');
  const embargo = nat(embargoMs, 'embargoMs'), ids = new Set(); let last = null;
  for (const row of samples) {
    requireThat(typeof row?.id === 'string' && row.id.length > 0 && !ids.has(row.id), 'SAMPLE_ID', 'Sample IDs must be nonempty and unique'); ids.add(row.id);
    const time = nat(row.time, 'sample.time'), label = nat(row.labelAvailableAt, 'sample.labelAvailableAt');
    const available = nat(row.availableAt ?? row.feature?.availableAt ?? row.time, 'sample.availableAt');
    requireThat(available >= time, 'SAMPLE_TIME', 'Feature availability cannot precede observation');
    requireThat((last === null || time > last) && label >= time, 'SAMPLE_TIME', 'Sample times must strictly increase and labels cannot predate observations'); last = time;
  }
  const folds = [], finalBoundary = finalStart < samples.length ? samples[finalStart].time : null;
  for (let start = trainSize; start + validationSize <= finalStart; start += stepSize) {
    const boundary = BigInt(samples[start].time), cutoff = String(boundary > embargo ? boundary - embargo : 0n);
    const train = [], purged = [], begin = expanding ? 0 : start - trainSize;
    for (let i = begin; i < start; i++) {
      const row = samples[i];
      (trainingAllowed({ observationTime: row.availableAt ?? row.feature?.availableAt ?? row.time, labelAvailableAt: row.labelAvailableAt, cutoff }) ? train : purged).push(i);
    }
    requireThat(train.length > 0, 'EMPTY_TRAIN_FOLD', 'Purging/embargo removed every training example');
    const validation = [], validationPurged = [];
    for (let i = start; i < start + validationSize; i++) {
      const row = samples[i];
      // Selection may consume forward labels only if all their information is
      // available strictly before the first final observation.
      (finalBoundary === null || trainingAllowed({ observationTime: row.availableAt ?? row.feature?.availableAt ?? row.time, labelAvailableAt: row.labelAvailableAt, cutoff: finalBoundary }) ? validation : validationPurged).push(i);
    }
    requireThat(validation.length > 0, 'EMPTY_VALIDATION_FOLD', 'Final-boundary purging removed every validation example');
    const body = { id: `fold-${folds.length + 1}`, train, validation, purged, validationPurged, cutoff, validationStart: samples[validation[0]].time, validationEnd: samples[validation.at(-1)].time };
    folds.push({ ...body, hash: hash(body) });
  }
  requireThat(folds.length > 0, 'NO_FOLDS', 'No complete validation window fits before final holdout');
  return frozenCopy({ format: 'walk-forward-v1', datasetHash: hash(samples), options: { trainSize, validationSize, stepSize, embargoMs, expanding, finalStart }, folds, final: Array.from({ length: samples.length - finalStart }, (_, i) => finalStart + i) });
}

/** No final partition is exposed here. Final release must use withFinalHoldout. */
export function foldRows(samples, plan, foldId, role, partition) {
  requireThat(hash(samples) === plan.datasetHash, 'DATASET_MISMATCH', 'Split plan belongs to different data');
  requireThat(partition !== 'final' && canReadPartition(role, partition), 'PARTITION_DENIED', 'Role cannot read requested partition');
  // Regenerate the plan rather than trusting caller-modified indices/hashes.
  const verified = walkForwardSplits(samples, plan.options);
  requireThat(hash(verified) === hash(plan), 'SPLIT_TAMPER', 'Split indices or options changed after planning');
  const fold = verified.folds.find(f => f.id === foldId);
  requireThat(fold, 'UNKNOWN_FOLD', `Unknown fold ${foldId}`);
  return frozenCopy(fold[partition].map(index => samples[index]));
}

/** Persistent one-shot release per dataset + named holdout, shared across processes.
 * A failed/crashed callback consumes the release too. This is a cooperative gate,
 * not a sandbox against direct filesystem reads or inventing a new holdout name.
 */
export async function withFinalHoldout(directory, { holdoutId, strategyHash, protocol, samples, plan }, work) {
  requireThat(typeof holdoutId === 'string' && holdoutId.length > 0 && /^[0-9a-f]{64}$/.test(strategyHash) && protocol && typeof protocol === 'object', 'HOLDOUT_PROTOCOL', 'Fix holdout ID, strategy content hash and evaluation protocol');
  requireThat(hash(samples) === plan.datasetHash && hash(walkForwardSplits(samples, plan.options)) === hash(plan) && plan.final.length > 0, 'HOLDOUT_PLAN', 'Final holdout plan must match data and contain rows');
  requireThat(canReadPartition('final', 'final') && typeof work === 'function', 'HOLDOUT_PROTOCOL', 'Final work callback required');
  mkdirSync(directory, { recursive: true });
  const key = hash({ holdoutId, datasetHash: plan.datasetHash }), token = randomUUID();
  const path = join(directory, `${key}.claim.json`);
  const claim = { format: 'holdout-release-v1', token, holdoutId, datasetHash: plan.datasetHash, planHash: hash(plan), strategyHash, protocol: structuredClone(protocol), releasedAt: new Date().toISOString(), pid: process.pid };
  try { writeFileSync(path, json(claim), { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('Final holdout has already been released; use its existing audit record'), { code: 'FINAL_TEST_REUSE' }); throw error; }
  const finalRows = frozenCopy(plan.final.map(i => samples[i]));
  try {
    const result = await work(finalRows, frozenCopy(claim));
    writeFileSync(join(directory, `${key}.result.json`), json({ token, status: 'completed', resultHash: hash(result), result }), { flag: 'wx' });
    return result;
  } catch (error) {
    writeFileSync(join(directory, `${key}.failure.json`), json({ token, status: 'failed', error: String(error.message || error) }), { flag: 'wx' });
    throw error;
  }
}

/** Explicit regular sampling for numerical research metrics, from ledger valuations. */
export function regularReturns(report, { intervalMs, periodsPerYear } = {}) {
  const interval = nat(intervalMs, 'intervalMs', true);
  requireThat(Number.isFinite(periodsPerYear) && periodsPerYear > 0, 'METRIC_CONVENTION', 'Provide a positive annualization frequency');
  requireThat(report.status === 'valid-under-declared-model' && report.dataQuality.status === 'accepted', 'INVALID_REPORT', 'Cannot compute ordinary metrics from an invalid report');
  const observations = report.valuations;
  requireThat(Array.isArray(observations), 'INVALID_REPORT', 'Valuations required');
  for (const row of observations) { nat(row.time, 'valuation.time'); nat(row.equity, 'valuation.equity'); }
  const returns = [];
  for (let i = 1; i < observations.length; i++) {
    requireThat(BigInt(observations[i].time) - BigInt(observations[i - 1].time) === interval, 'IRREGULAR_SAMPLING', 'Every valuation must lie on the declared regular grid; resampling must be explicit');
    const before = BigInt(observations[i - 1].equity), after = BigInt(observations[i].equity);
    requireThat(before > 0n && after >= 0n, 'UNDEFINED_RETURN', 'Return requires positive starting equity and nonnegative ending equity');
    returns.push(Number(after - before) / Number(before));
  }
  if (returns.length < 2) return { returns, sharpe: null, reason: 'Fewer than two return observations', intervalMs, periodsPerYear };
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  const sharpe = variance === 0 ? null : mean / Math.sqrt(variance) * Math.sqrt(periodsPerYear);
  requireThat(sharpe === null || Number.isFinite(sharpe), 'NUMERICAL_METRIC', 'Metric overflow');
  return { returns, sharpe, reason: sharpe === null ? 'Zero sample variance' : null, intervalMs, periodsPerYear, convention: 'Arithmetic returns; sample standard deviation; zero risk-free rate; excludes unsampled initial-to-first-quote period', numericalStatus: 'Floating-point research metric, not formally proved' };
}

/** Comparison keeps failed/invalid trials visible and never silently ranks final results. */
export function comparisonTable(trials) {
  requireThat(Array.isArray(trials), 'COMPARISON_INPUT', 'trials must be an array');
  const ids = new Set();
  return trials.map(({ id, status, report, error }) => {
    requireThat(typeof id === 'string' && !ids.has(id), 'TRIAL_ID', 'Unique trial IDs required'); ids.add(id);
    const valid = status === 'completed' && report?.status === 'valid-under-declared-model';
    return { id, status, valid, netPnl: valid ? report.performance.netPnl : null, totalReturn: valid ? report.performance.totalReturn : null, fees: valid ? report.performance.fees : null, traceHash: report?.traceHash || null, error: error || (valid ? null : report?.status || 'No valid report') };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
