import { requireThat } from '../../src/core.mjs';
import { randomSequence } from './protocol.mjs';

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const quantile = (sorted, p) => {
  const at = (sorted.length - 1) * p, low = Math.floor(at);
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
};
const distribution = values => {
  const average = mean(values), sorted = [...values].sort((a, b) => a - b);
  return { meanMs: average, medianMs: quantile(sorted, 0.5),
    standardDeviationMs: values.length < 2 ? null : Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)) };
};

const timeRatio = pairs => mean(pairs.map(row => row.candidate)) / mean(pairs.map(row => row.baseline));

// These fixed screens expose confounding; passing them is not proof of independence.
function comparisonDiagnostics(protocol, pairs) {
  const policy = protocol.diagnosticPolicy, issues = [];
  const groups = Object.fromEntries(['AB', 'BA'].map(order => {
    const rows = pairs.filter(row => row.order === order);
    return [order, { pairs: rows.length, timeRatio: rows.length ? timeRatio(rows) : null }];
  }));
  let orderEffectChange = null;
  if (Object.values(groups).some(group => group.pairs < policy.minimumStratumPairs)) issues.push('insufficient-order-pairs');
  else {
    orderEffectChange = groups.AB.timeRatio / groups.BA.timeRatio - 1;
    if (Math.abs(orderEffectChange) > policy.orderEffectThreshold) issues.push('order-effect');
  }
  const chronological = [...pairs].sort((a, b) => a.runOrder - b.runOrder), half = Math.floor(pairs.length / 2);
  const drift = {};
  if (half < policy.minimumStratumPairs) issues.push('insufficient-drift-pairs');
  else for (const target of ['baseline', 'candidate']) {
    const earlyMeanMs = mean(chronological.slice(0, half).map(row => row[target]));
    const lateMeanMs = mean(chronological.slice(-half).map(row => row[target]));
    const change = lateMeanMs / earlyMeanMs - 1;
    drift[target] = { earlyMeanMs, lateMeanMs, change, pairsPerWindow: half };
    if (Math.abs(change) > policy.driftThreshold) issues.push(`${target}-drift`);
  }
  return { status: issues.length ? 'requires-review' : 'passed', issues, policy, orderGroups: groups, orderEffectChange, drift };
}

/** Internal reporting seam: resample process pairs, never their individual ticks. */
export function summarizeComparison(protocol, samples) {
  return protocol.cases.map(caseId => {
    const rows = samples.filter(row => row.caseId === caseId && row.stage === 'measurement');
    requireThat(rows.every(row => Number.isInteger(row.pair) && row.pair >= 0 && row.pair < protocol.pairs && ['baseline', 'candidate'].includes(row.target)),
      'BENCHMARK_SAMPLES', 'Unexpected measurement identity');
    const pairs = [];
    for (let pair = 0; pair < protocol.pairs; pair++) {
      const members = rows.filter(row => row.pair === pair);
      requireThat(new Set(members.map(row => row.target)).size === members.length, 'BENCHMARK_SAMPLES', 'Duplicate pair member');
      const baseline = members.find(row => row.target === 'baseline'), candidate = members.find(row => row.target === 'candidate');
      if (baseline?.status === 'completed' && candidate?.status === 'completed' &&
        typeof baseline.evidenceHash === 'string' && baseline.evidenceHash.length > 0 && baseline.evidenceHash === candidate.evidenceHash) {
        requireThat([baseline.jobWallMs, candidate.jobWallMs].every(value => Number.isFinite(value) && value > 0),
          'BENCHMARK_SAMPLES', 'Completed timings must be finite and positive');
        pairs.push({ baseline: baseline.jobWallMs, candidate: candidate.jobWallMs,
          order: members[0].target === 'baseline' ? 'AB' : 'BA', runOrder: rows.indexOf(members[0]) });
      }
    }
    const summary = { caseId, primary: caseId === protocol.primaryCase, plannedPairs: protocol.pairs, attemptedMembers: rows.length,
      completedPairs: pairs.length, eligibleForInference: pairs.length === protocol.pairs && protocol.profile === 'release',
      conclusion: pairs.length < protocol.pairs ? 'incomplete' : protocol.profile === 'smoke' ? 'smoke-only' : protocol.profile === 'pilot' ? 'pilot-only' : 'inconclusive' };
    if (pairs.length < 2) return summary;
    const diagnostics = comparisonDiagnostics(protocol, pairs);
    if (summary.eligibleForInference && diagnostics.status !== 'passed') {
      summary.eligibleForInference = false;
      summary.conclusion = 'requires-review';
    }
    const baseline = distribution(pairs.map(row => row.baseline)), candidate = distribution(pairs.map(row => row.candidate));
    const random = randomSequence(protocol.analysisSeed), ratios = [];
    for (let draw = 0; draw < protocol.bootstrapDraws; draw++) {
      let b = 0, c = 0;
      for (let i = 0; i < pairs.length; i++) { const row = pairs[Math.floor(random() * pairs.length)]; b += row.baseline; c += row.candidate; }
      ratios.push(c / b);
    }
    ratios.sort((a, b) => a - b);
    const interval = [quantile(ratios, 0.025), quantile(ratios, 0.975)], q = candidate.meanMs / baseline.meanMs;
    if (summary.eligibleForInference) {
      const low = 1 - protocol.practicalThreshold, high = 1 + protocol.practicalThreshold;
      summary.conclusion = interval[1] < low ? 'improvement' : interval[0] > high ? 'regression' :
        interval[0] >= low && interval[1] <= high ? 'within-tolerance' : 'inconclusive';
    }
    return { ...summary, diagnostics, baseline, candidate, timeRatio: q, speedup: 1 / q, candidateTimeChangePercent: 100 * (q - 1),
      timeRatio95PercentInterval: interval, observationsPerSecond: { baseline: protocol.ticks * 1000 / baseline.meanMs, candidate: protocol.ticks * 1000 / candidate.meanMs },
      intervalMethod: 'percentile bootstrap of whole process pairs', diagnosticOnly: !summary.eligibleForInference,
      preliminary: protocol.profile === 'pilot' };
  });
}
