import { freeze, hash, integer, nat, requireThat } from './core.mjs';
import { admitSplitPlan, summarizeRegularReturns } from './evaluation.mjs';
import { runStrategy } from './replay.mjs';
import { readReplayAudit } from './recording.mjs';
import { verifiedRuntimeProvenance } from './provenance.mjs';
import { openStudyCache } from './study-cache.mjs';

/** Explicit last-known-equity sampling; no interpolation or future marks. */
export function sampleEquity(report, { startTime, endTime, intervalMs, maxStalenessMs } = {}) {
  return [...sampledEquity(report, { startTime, endTime, intervalMs, maxStalenessMs })];
}

function* sampledEquity(report, { startTime, endTime, intervalMs, maxStalenessMs }) {
  const start = nat(startTime, 'startTime'), end = nat(endTime, 'endTime');
  const interval = nat(intervalMs, 'intervalMs', true), age = nat(maxStalenessMs, 'maxStalenessMs');
  requireThat(end >= start && (end - start) % interval === 0n, 'METRIC_GRID', 'Evaluation endpoints must lie on the declared sampling grid');
  requireThat(report?.status === 'valid-under-declared-model' && report.dataQuality?.status === 'accepted', 'INVALID_REPORT', 'Sampling requires a valid report');
  requireThat(!report.terminal?.bankrupt && BigInt(report.terminal?.deficit ?? '0') === 0n, 'UNDEFINED_RETURN', 'Deficit accounts cannot produce ordinary return metrics');
  const rows = report.audit ? readReplayAudit(report, 'valuations') : report.valuations;
  requireThat(rows && typeof rows[Symbol.iterator] === 'function', 'INVALID_REPORT', 'Valuation records required');
  let next = start, previousTime = null, latest = null;
  const emit = () => {
    requireThat(latest && next - BigInt(latest.time) <= age, 'STALE_SAMPLING', 'No sufficiently fresh valuation at sampling time');
    requireThat(latest.equity !== null && integer(String(latest.equity), 'equity') > 0n, 'UNDEFINED_RETURN', 'Ordinary returns require positive, marked equity');
    const row = { time: String(next), equity: String(latest.equity) }; next += interval;
    return row;
  };
  for (const row of rows) {
    const time = nat(typeof row.time === 'bigint' ? String(row.time) : row.time, 'valuation.time');
    requireThat(previousTime === null || time >= previousTime, 'IRREGULAR_SAMPLING', 'Valuation times cannot decrease');
    previousTime = time;
    // Emit strictly earlier grid points: the last record at a timestamp wins.
    while (next <= end && next < time) yield emit();
    if (time >= start && time <= end) requireThat(row.equity !== null && integer(String(row.equity), 'equity') > 0n,
      'UNDEFINED_RETURN', 'Unmarked or nonpositive equity inside evaluation invalidates ordinary returns');
    latest = row;
  }
  while (next <= end) yield emit();
}

function protocolOf(protocol) {
  requireThat(protocol && Object.keys(protocol).every(key => ['warmup', 'account', 'intervalMs', 'periodsPerYear', 'maxStalenessMs'].includes(key)), 'STUDY_PROTOCOL', 'Unknown study protocol option');
  requireThat(protocol.warmup === 'history-only' && protocol.account === 'reset-per-fold', 'STUDY_PROTOCOL', 'Declare history-only warmup and reset-per-fold accounts');
  nat(protocol.intervalMs, 'intervalMs', true); nat(protocol.maxStalenessMs, 'maxStalenessMs');
  requireThat(Number.isFinite(protocol.periodsPerYear) && protocol.periodsPerYear > 0, 'STUDY_PROTOCOL', 'Declare a positive annualization frequency');
  return freeze(structuredClone(protocol));
}

function aggregate(results) {
  let initial = 0n, net = 0n, fees = 0n;
  for (const { report } of results) {
    const performance = report.performance;
    initial += nat(performance.totalReturn.denominator, 'initialEquity', true);
    net += integer(performance.netPnl, 'netPnl'); fees += nat(performance.fees, 'fees');
  }
  return { initialEquity: String(initial), netPnl: String(net), fees: String(fees), totalReturn: { numerator: String(net), denominator: String(initial) },
    convention: 'Independent reset accounts; sum P&L divided by sum initial capital; not a compounded equity curve' };
}

const routingIdentity = (report, venue) => {
  const identity = adapter => ({ instrument: adapter.instrument, datasetHash: adapter.datasetHash, model: adapter.model ?? null });
  const { manifest, ...config } = venue.config ?? venue.backtest?.config ?? {};
  return { informationSource: identity(report.routing.informationSource), executionVenue: identity(report.routing.executionVenue),
    executionConfig: config, executionPolicyHash: report.routing.executionVenue.executionPolicyHash ?? null,
    barAssumptions: report.barReplay?.assumptions ?? null };
};

function aggregateBaselines(folds, names, candidate) {
  return Object.fromEntries(names.map(name => {
    const baseline = aggregate(folds.map(fold => fold.baselines[name]));
    const a = candidate.totalReturn, b = baseline.totalReturn;
    return [name, { ...baseline, excessReturn: { numerator: String(BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator)),
      denominator: String(BigInt(a.denominator) * BigInt(b.denominator)) } }];
  }));
}

/** All validation folds, fresh accounts, comparable baselines and explicit metrics.
 * Optional resume: { directory, preparationHash, previousDirectories? }.
 * preparationHash is
 * the caller's SHA256 attestation of callback/import content, model and strategy
 * configuration, execution datasets/configuration, and all seeds. Runtime/data/
 * split/protocol identities are independently pinned; closure behavior cannot be
 * independently hashed. Cache directories hold validation folds only. Explicit
 * previousDirectories are read-only; verified folds accumulate in directory,
 * which must be writable by this attempt. Preserve referenced disk audit files.
 */
export async function evaluateStudy({ samples, plan, protocol, resume }, prepareFold) {
  protocol = protocolOf(protocol);
  requireThat(typeof prepareFold === 'function' && plan?.folds?.length > 0, 'STUDY_INPUT', 'A split plan and fold preparation callback are required');
  const admitted = admitSplitPlan(samples, plan);
  plan = admitted.plan;
  let cache = null;
  if (resume !== undefined) {
    requireThat(resume && Object.keys(resume).every(key => ['directory', 'preparationHash', 'previousDirectories'].includes(key)) && typeof resume.preparationHash === 'string' && /^[0-9a-f]{64}$/.test(resume.preparationHash),
      'STUDY_CACHE_INPUT', 'Resume requires an explicit preparationHash SHA256 covering callback dependencies, execution configuration and seeds');
    cache = openStudyCache(resume, { datasetHash: plan.datasetHash, planHash: admitted.planHash, protocol, preparationHash: resume.preparationHash,
      runtime: { ...verifiedRuntimeProvenance(), node: process.version, platform: process.platform, architecture: process.arch } }, plan.folds.map(fold => fold.id));
  }
  const folds = [], identities = [];
  let baselineNames = null;
  for (const fold of plan.folds) {
    const training = admitted.foldRows(fold.id, 'train', 'train');
    const evaluation = admitted.foldRows(fold.id, 'select', 'validation');
    const available = row => row.decisionTime ?? row.availableAt ?? row.feature?.availableAt ?? row.time;
    const startTime = available(evaluation.rows[0]), endTime = available(evaluation.rows.at(-1));
    const foldIdentity = { id: fold.id, foldHash: fold.hash, trainingHash: training.hash, evaluationHash: evaluation.hash, startTime, endTime };
    const cached = cache?.load(foldIdentity);
    if (cached) {
      const names = cached.baselineNames;
      requireThat(names.length > 0 && !names.includes('candidate') && hash(names) === hash([...names].sort()) && hash(names) === hash(Object.keys(cached.fold.baselines).sort()),
        'STUDY_CACHE_CORRUPT', 'Cached fold baseline population is invalid');
      baselineNames ??= names;
      requireThat(hash(names) === hash(baselineNames), 'STUDY_BASELINE', 'Every cached fold must use the same baseline population');
      for (const result of [cached.fold.candidate, ...names.map(name => cached.fold.baselines[name])]) {
        requireThat(hash(routingIdentity(result.report, { config: cached.route.executionConfig })) === hash(cached.route), 'STUDY_CACHE_CORRUPT', 'Cached candidate and baselines must share their recorded execution identity');
        const metrics = summarizeRegularReturns({ ...result.report, valuations: sampledEquity(result.report, { startTime, endTime, ...protocol }) }, protocol);
        requireThat(hash(metrics) === hash(result.metrics), 'STUDY_CACHE_CORRUPT', 'Cached metrics do not match their verified report and protocol');
      }
      cache.save(foldIdentity, cached);
      identities.push(cached.route); folds.push(cached.fold);
      continue;
    }
    const prepared = await prepareFold({ fold, training, evaluation, protocol });
    requireThat(prepared && typeof prepared.createReplay === 'function' && typeof prepared.strategy === 'function', 'STUDY_INPUT', 'Prepare a strategy and fresh replay factory');
    const baselines = prepared.baselines ?? {};
    const names = Object.keys(baselines).sort();
    requireThat(names.length > 0 && !names.includes('candidate') && names.every(name => typeof baselines[name] === 'function'), 'STUDY_BASELINE', 'At least one named baseline strategy is required');
    baselineNames ??= names;
    requireThat(hash(names) === hash(baselineNames), 'STUDY_BASELINE', 'Every fold must use the same baseline population');
    const start = nat(startTime, 'evaluation start'), end = nat(endTime, 'evaluation end');
    const results = {};
    let identity = null;
    for (const [variant, strategy] of [['candidate', prepared.strategy], ...names.map(name => [name, baselines[name]])]) {
      const { informationSource, executionVenue } = await prepared.createReplay({ variant });
      // Warmup only supplies history. Strategy state and exposure start at validation.
      const source = { instrument: informationSource.instrument, manifest: informationSource.manifest,
        *observations() { for (const row of informationSource.observations()) { if (BigInt(row.availableAt) > end) break; yield row; } } };
      const gated = context => BigInt(context.time) < start ? null : strategy(context);
      if (strategy.lookback !== undefined) gated.lookback = strategy.lookback;
      const run = runStrategy(source, executionVenue, gated);
      requireThat(run.endTime === endTime, 'STUDY_WINDOW', 'Information source must reach the exact evaluation endpoint');
      const report = run.report();
      const valuations = sampledEquity(report, { startTime, endTime, ...protocol });
      const metrics = summarizeRegularReturns({ ...report, valuations }, protocol);
      const route = routingIdentity(report, executionVenue);
      identity ??= route;
      requireThat(hash(route) === hash(identity), 'STUDY_BASELINE', 'Candidate and baselines must share information and execution datasets, instruments and models');
      results[variant] = { report, metrics };
    }
    identities.push(identity);
    const completed = { ...foldIdentity, candidate: results.candidate, baselines: Object.fromEntries(names.map(name => [name, results[name]])), metadata: prepared.metadata ?? null };
    cache?.save(foldIdentity, { fold: completed, route: identity, baselineNames: names });
    folds.push(completed);
  }
  const candidate = aggregate(folds.map(fold => fold.candidate));
  const baselines = aggregateBaselines(folds, baselineNames, candidate);
  const body = { format: 'validation-study-v1', partition: 'validation', status: 'completed', datasetHash: plan.datasetHash, planHash: admitted.planHash, plan, protocol,
    comparisonHash: hash({ datasetHash: plan.datasetHash, planHash: admitted.planHash, protocol, identities, baselineNames,
      baselineSignals: folds.map(fold => baselineNames.map(name => fold.baselines[name].report.signals.targetsHash)) }), folds, aggregate: candidate, baselines };
  return freeze({ ...body, hash: hash(body) });
}

function completeStudy(study) {
  try {
    const { hash: digest, ...body } = study;
    if (study.format !== 'validation-study-v1' || study.partition !== 'validation' || study.status !== 'completed' || digest !== hash(body)) return false;
    protocolOf(study.protocol);
    if (study.plan?.format !== 'walk-forward-v1' || hash(study.plan) !== study.planHash || study.plan.datasetHash !== study.datasetHash ||
      !Array.isArray(study.folds) || !study.folds.length || study.folds.length !== study.plan.folds.length || !/^[0-9a-f]{64}$/.test(study.comparisonHash)) return false;
    const names = Object.keys(study.baselines).sort();
    if (!names.length) return false;
    for (const [index, fold] of study.folds.entries()) {
      if (fold.id !== study.plan.folds[index].id || fold.foldHash !== study.plan.folds[index].hash || hash(Object.keys(fold.baselines).sort()) !== hash(names)) return false;
      for (const { report } of [fold.candidate, ...names.map(name => fold.baselines[name])]) {
        if (report.status !== 'valid-under-declared-model' || report.dataQuality?.status !== 'accepted' || report.terminal?.bankrupt || BigInt(report.terminal?.deficit ?? '0') !== 0n) return false;
        const performance = report.performance;
        if (integer(performance.terminalEquity, 'terminalEquity') <= 0n || performance.totalReturn.numerator !== performance.netPnl ||
          BigInt(performance.totalReturn.denominator) + BigInt(performance.netPnl) !== BigInt(performance.terminalEquity)) return false;
      }
    }
    const candidate = aggregate(study.folds.map(fold => fold.candidate));
    return hash(candidate) === hash(study.aggregate) && hash(aggregateBaselines(study.folds, names, candidate)) === hash(study.baselines);
  } catch { return false; }
}

/** Select only comparable validation studies, preserving the complete trial population. */
export function selectStudy(trials) {
  requireThat(Array.isArray(trials), 'STUDY_POPULATION', 'Trial population must be an array');
  const ids = new Set(); let comparison = null;
  const population = trials.map(({ id, status, study, error }) => {
    requireThat(typeof id === 'string' && id.length > 0 && !ids.has(id), 'TRIAL_ID', 'Unique nonempty trial IDs required'); ids.add(id);
    let valid = false, reason = error ?? null;
    if (status === 'completed' && study) {
      valid = completeStudy(study);
      if (valid) {
        comparison ??= study.comparisonHash;
        requireThat(study.comparisonHash === comparison, 'STUDY_COMPARISON', 'Cannot select across different data, folds, protocols or baseline populations');
      }
    }
    if (!valid) reason ??= 'No complete verified validation study';
    return { id, status, valid, totalReturn: valid ? study.aggregate.totalReturn : null, netPnl: valid ? study.aggregate.netPnl : null, studyHash: valid ? study.hash : null, error: reason };
  }).sort((a, b) => a.id.localeCompare(b.id));
  let selected = null;
  for (const trial of population) if (trial.valid) {
    const value = trial.totalReturn, best = selected?.totalReturn;
    requireThat(BigInt(value.denominator) > 0n, 'STUDY_RESULT', 'Aggregate capital must be positive');
    if (!best || BigInt(value.numerator) * BigInt(best.denominator) > BigInt(best.numerator) * BigInt(value.denominator)) selected = trial;
  }
  return { selectedId: selected?.id ?? null, metric: 'aggregate-validation-return', tieBreak: 'lexical trial ID', comparisonHash: comparison, population };
}
