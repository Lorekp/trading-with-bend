import { canonical, requireThat } from '../../src/core.mjs';

const profiles = {
  smoke: { ticks: 1024, pairs: 2 },
  pilot: { ticks: 200000, pairs: 5 },
  release: { ticks: 200000, pairs: 20 },
};

export function resolveProtocol(input) {
  const fields = ['schema', 'suite', 'profile', 'datasetSeed', 'scheduleSeed', 'analysisSeed', 'pairs', 'timeoutMs'];
  const resolvedInput = input?.schema === 'speed-benchmark-resolved-v1';
  requireThat(input && (resolvedInput || Object.keys(input).every(key => fields.includes(key))),
    'BENCHMARK_PROTOCOL', 'Unknown benchmark protocol field');
  requireThat((input.schema === 'speed-benchmark-v1' || resolvedInput) && input.suite === 'quote-replay-v1' && Object.hasOwn(profiles, input.profile),
    'BENCHMARK_PROTOCOL', 'Use speed-benchmark-v1, quote-replay-v1 and profile smoke, pilot or release');
  for (const field of ['datasetSeed', 'scheduleSeed', 'analysisSeed']) {
    requireThat(Number.isInteger(input[field]) && input[field] >= (field === 'datasetSeed' ? 1 : 0) && input[field] <= 0xffffffff,
      'BENCHMARK_SEED', `${field} must be a uint32${field === 'datasetSeed' ? ' greater than zero' : ''}`);
  }
  const pairs = input.pairs ?? profiles[input.profile].pairs, timeoutMs = input.timeoutMs ?? 300000;
  requireThat(Number.isSafeInteger(pairs) && pairs >= (input.profile === 'release' ? 20 : 2) && pairs <= 10000,
    'BENCHMARK_BUDGET', 'Use 2..10000 pairs, or at least 20 for release');
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs >= 30000 && timeoutMs <= 3600000,
    'BENCHMARK_BUDGET', 'timeoutMs must be 30000..3600000');
  const protocol = {
    ...Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])),
    schema: 'speed-benchmark-resolved-v1', ...profiles[input.profile], pairs,
    primaryCase: 'quotes-variable-dense',
    cases: ['quotes-variable-dense', 'quotes-constant-dense'],
    generator: 'syntheticQuotes/xorshift32-v1', orderEvery: 32, lookback: 256,
    traceMode: 'compact', orderStorage: 'active', reportDetail: 'summary',
    instrument: { symbol: 'BENCH', currency: 'USDT', lotSize: '0.001', priceTick: '1' },
    quoteParameters: {
      'quotes-variable-dense': { initialBid: '10000', spreadTicks: '1', stepMs: '1', volatilityTicks: '3', minLots: '1', maxLots: '100' },
      'quotes-constant-dense': { initialBid: '10000', spreadTicks: '1', stepMs: '1', volatilityTicks: '0', minLots: '100', maxLots: '100' },
    },
    execution: { initialCash: '100000000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '60000' },
    timeoutMs, heapMiB: 256, cachePolicy: 'pre-read',
    warmupIterations: 0, bootstrapDraws: 10000, practicalThreshold: 0.05,
    diagnosticPolicy: { orderEffectThreshold: 0.05, driftThreshold: 0.05, minimumStratumPairs: 2 },
  };
  requireThat(!resolvedInput || canonical(input) === canonical(protocol), 'BENCHMARK_PROTOCOL',
    'Resolved protocol differs from its versioned suite; only pairs and timeoutMs may be calibrated');
  return protocol;
}

// Benchmark-local deterministic LCG, matching the existing study fixture pattern.
export function randomSequence(seed) {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

export function pairSchedule(protocol) {
  const random = randomSequence(protocol.scheduleSeed), schedule = [];
  for (const caseId of protocol.cases) {
    const orders = Array.from({ length: protocol.pairs }, (_, i) => i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']);
    for (let i = orders.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1)); [orders[i], orders[j]] = [orders[j], orders[i]];
    }
    for (let pair = 0; pair < orders.length; pair++) schedule.push({ caseId, pair, order: orders[pair] });
  }
  for (let i = schedule.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [schedule[i], schedule[j]] = [schedule[j], schedule[i]];
  }
  return schedule;
}
