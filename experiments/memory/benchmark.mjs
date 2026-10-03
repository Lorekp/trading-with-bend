import { cpus, freemem, hostname, release, totalmem } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../../src/core.mjs';
import { verifiedRuntimeProvenance } from '../../src/provenance.mjs';
import { openQuoteData } from '../../src/quote-data.mjs';
import { openReplayAudit } from '../../src/recording.mjs';
import { collect, prepareCollector, artifactHashes } from './collectors.mjs';
import { fileHash, publish, expectedRoundtrip, instrument } from './support.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const supervisor = join(root, 'supervisor.mjs');
const integer = (value, min, max, name) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`BENCHMARK_PLAN: ${name} must be in ${min}..${max}`);
  return value;
};
function keys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`BENCHMARK_PLAN: invalid ${name}`);
}
function expand(input) {
  keys(input, ['version', 'suite', 'datasetManifest', 'repetitions', 'orderSeed', 'timeoutMs', 'runtime', 'sampleMs', 'budgetBytes', 'ticks', 'workers', 'jobs', 'orderEvery'], 'plan');
  if (input.version !== 1) throw new Error('BENCHMARK_PLAN: version must be 1');
  const runtime = input.runtime ?? {};
  keys(runtime, ['nodeOptions', 'cgroupParent'], 'runtime');
  const nodeOptions = runtime.nodeOptions ?? '--max-old-space-size=2048';
  if (typeof nodeOptions !== 'string' || !/^(?:\s*--max-(?:old|semi)-space-size=[1-9]\d*)*\s*$/.test(nodeOptions)) throw new Error('BENCHMARK_PLAN: only explicit V8 heap size flags are allowed; GC/profilers are diagnostic');
  if (runtime.cgroupParent !== undefined && (process.platform !== 'linux' || typeof runtime.cgroupParent !== 'string')) throw new Error('BENCHMARK_PLAN: cgroupParent requires Linux and a directory');
  const suite = input.suite ?? 'smoke-v1';
  if (!['smoke-v1', 'replay-v1', 'campaign-v1', 'replay-demanding-v1', 'controls-v1', 'collector-calibration-v1', 'retention-v1', 'restore-v1', 'churn-v1', 'overhead-v1'].includes(suite)) throw new Error(`BENCHMARK_PLAN: unknown suite ${suite}`);
  const ticks = integer(input.ticks ?? (suite === 'smoke-v1' ? 1307 : suite === 'retention-v1' ? 25000 : suite === 'churn-v1' ? 1024 : 250000), 2, 10000000, 'ticks');
  const workers = integer(input.workers ?? 5, 1, 32, 'workers');
  const jobs = integer(input.jobs ?? workers, 1, 32, 'jobs');
  const orderEvery = integer(input.orderEvery ?? (suite === 'smoke-v1' ? 32 : 288), 2, 10000000, 'orderEvery');
  const plan = { version: 1, suite, repetitions: integer(input.repetitions ?? (suite === 'smoke-v1' ? 2 : 7), 1, 100, 'repetitions'),
    orderSeed: integer(input.orderSeed ?? 41, 0, 0xffffffff, 'orderSeed'), timeoutMs: integer(input.timeoutMs ?? 3600000, 1, 2147460000, 'timeoutMs'),
    sampleMs: integer(input.sampleMs ?? 50, 0, 10000, 'sampleMs'), runtime: { ...runtime, nodeOptions },
    ...(input.budgetBytes === undefined ? {} : { budgetBytes: integer(input.budgetBytes, 1048576, Number.MAX_SAFE_INTEGER, 'budgetBytes') }),
    ...(input.datasetManifest === undefined ? {} : { datasetManifest: resolve(input.datasetManifest) }) };
  const replay = (count, changes = {}) => ({ id: `replay-${count}`, jobs: 1, concurrency: 1,
    configuration: { kind: 'replay', count, orderEvery, lookback: 256, traceMode: 'compact', orderStorage: 'active', dataStorage: 'disk', auditStorage: 'disk', detail: 'summary' }, ...changes });
  let cases;
  if (suite === 'collector-calibration-v1') {
    cases = (process.platform === 'win32' ? ['idle', 'buffer', 'native', 'native-sequential', 'native-overlap', 'native-orphan'] : ['idle', 'buffer']).map(mode => ({ id: `calibration-${mode}`, jobs: 1, concurrency: 1, configuration: { kind: 'calibration', mode } }));
  } else if (suite === 'replay-demanding-v1') {
    if (['ticks', 'workers', 'jobs', 'datasetManifest'].some(key => key in input)) throw new Error('BENCHMARK_PLAN: demanding suite prepares its frozen size/population fixtures; use replay-v1 or campaign-v1 to customize');
    cases = [250000, 1000000, 2000000].map(count => replay(count));
    for (const concurrency of [1, 2, 5]) cases.push(replay(2000000, { id: `campaign-2000000-c${concurrency}`, jobs: 5, concurrency }));
  } else if (suite === 'overhead-v1') cases = [0, 10, 50, 200].map(sampleMs => replay(ticks, { id: `overhead-${ticks}-sample${sampleMs}`, sampleMs }));
  else if (suite === 'retention-v1') cases = [replay(ticks, { id: `retention-${ticks}`, configuration: { ...replay(ticks).configuration, kind: 'retention' } })];
  else if (suite === 'churn-v1') cases = [1, 64, 512].map(workingOrders => ({ id: `churn-${ticks}-working${workingOrders}`, jobs: 1, concurrency: 1, configuration: { kind: 'churn', count: ticks, workingOrders } }));
  else if (suite === 'restore-v1') cases = [0.25, 0.5, 1].map(fraction => ({ id: `restore-${ticks}-prefix${Math.floor(ticks * fraction)}`, jobs: 1, concurrency: 1,
    configuration: { kind: 'checkpoint-restore', count: ticks, prefix: Math.max(1, Math.floor(ticks * fraction)) } }));
  else if (suite === 'campaign-v1') cases = [replay(ticks, { id: `campaign-${ticks}-j${jobs}-c${workers}`, jobs, concurrency: workers })];
  else if (suite === 'smoke-v1') cases = [replay(ticks), replay(ticks, { id: `campaign-${ticks}-j2-c2`, jobs: 2, concurrency: 2 })];
  else if (suite === 'controls-v1') {
    const base = replay(ticks); cases = [base];
    for (const [name, setting] of Object.entries({ 'memory-data': { dataStorage: 'memory' }, 'memory-audit-full-report': { auditStorage: 'memory', detail: 'full' },
      'all-history': { lookback: 'all' }, 'full-report': { detail: 'full' }, 'dense-orders': { orderEvery: 2 } })) {
      cases.push({ ...base, id: `${base.id}-${name}`, configuration: { ...base.configuration, ...setting } });
    }
    const referenceCount = Math.min(ticks, 10000);
    for (const traceMode of ['compact', 'full']) cases.push(replay(referenceCount, { id: `reference-${referenceCount}-${traceMode}`,
      configuration: { ...replay(referenceCount).configuration, dataStorage: 'memory', auditStorage: 'memory', orderStorage: 'all', traceMode, detail: 'full' } }));
  } else cases = [replay(ticks)];
  return { ...plan, cases };
}
function sources() {
  return Object.fromEntries(readdirSync(root).filter(name => /\.(mjs|cs|sh)$/.test(name)).sort().map(name => [name, fileHash(join(root, name))]));
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
};
function statistics(values) {
  const center = median(values);
  return { count: values.length, median: center, minimum: values.length ? Math.min(...values) : null,
    maximum: values.length ? Math.max(...values) : null, mad: center === null ? null : median(values.map(value => Math.abs(value - center))) };
}
function shuffled(values, seed) {
  let state = seed >>> 0;
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1); [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function verifyWorkload(workload, configuration) {
  if (workload.status !== 'completed') throw new Error('BENCHMARK_CORRECTNESS: workload failed');
  if (['prepare', 'checkpoint-prepare'].includes(configuration.kind)) return;
  if (configuration.kind === 'calibration') {
    if (!workload.results.every(row => row.result.correctness === 'passed')) throw new Error('BENCHMARK_CORRECTNESS: calibration failed');
    return;
  }
  for (const row of workload.results) {
    const results = row.result.cycles ? row.result.cycles.map(cycle => cycle.result) : [row.result];
    for (const result of results) {
      const expected = configuration.kind === 'churn' ? { fills: configuration.count, ledger: { cash: String(100000000 - configuration.count * 101), quantity: String(configuration.count) } } :
        configuration.kind === 'checkpoint-restore' ? { fills: 0, ledger: { cash: '100000000', quantity: '0' } } : expectedRoundtrip(configuration.count, result.index, configuration.orderEvery);
      if (result.correctness !== 'passed' || result.count !== configuration.count || result.fills !== expected.fills || (expected.events !== undefined && result.events !== expected.events) ||
        result.ledger.cash !== expected.ledger.cash || result.ledger.quantity !== expected.ledger.quantity) throw new Error('BENCHMARK_CORRECTNESS: independent ledger differs');
      if (result.audit) {
        const audit = openReplayAudit(result.audit);
        let cash = 100000000n, quantity = 0n, count = 0;
        try {
          for (const fill of audit.records('fills')) {
            const size = BigInt(fill.quantity), price = BigInt(fill.price), fee = BigInt(fill.fee);
            if (fill.side === 'buy') { cash -= size * price + fee; quantity += size; }
            else { cash += size * price - fee; quantity -= size; }
            count++;
          }
        } finally { audit.close(); }
        if (count !== expected.fills || String(cash) !== result.ledger.cash || String(quantity) !== result.ledger.quantity) throw new Error('BENCHMARK_CORRECTNESS: saved fill postings differ');
      }
    }
  }
}

/** Whole-workload capacity: callers and tests use this same execution seam. */
export async function runMemoryBenchmark(input, { outputDirectory }) {
  const plan = expand(input), toolkit = verifiedRuntimeProvenance(), sourceHashes = sources();
  const resolvedCases = structuredClone(plan.cases);
  if (typeof outputDirectory !== 'string' || !outputDirectory.length) throw new Error('BENCHMARK_PLAN: outputDirectory must be a new directory');
  if (plan.datasetManifest) {
    const data = openQuoteData(plan.datasetManifest);
    try {
      if (plan.cases.some(row => row.configuration.count !== data.manifest.audit.streams.quotes.count) || hash(data.instrument) !== hash(instrument)) throw new Error('BENCHMARK_FIXTURE: fixture count/instrument differs');
    } finally { data.close(); }
  }
  const directory = resolve(outputDirectory);
  mkdirSync(dirname(directory), { recursive: true }); mkdirSync(directory); // Never reuse an old population.
  const collector = await prepareCollector(plan.runtime, directory);
  const host = { hostname: hostname(), os: process.platform, release: release(), architecture: process.arch, cpu: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), load: 'uncontrolled-local-host',
    filesystemCache: 'fixture-validated-before-replay; actual-residency-unverified', storage: 'local-filesystem',
    runtime: { node: process.version, v8: process.versions.v8, libuv: process.versions.uv } };
  publish(join(directory, 'plan.json'), { plan, host, toolkit, sourceHashes, collector });
  const attempts = [], fixtures = new Map(), identities = new Map();
  const metricName = collector.source === 'windows-job' ? 'groupCommittedPeakBytes' : 'groupChargedPeakBytes';
  async function attempt(caseSpec, repetition, role = 'measurement') {
    const id = `${role}-${caseSpec.id}-r${repetition}`, attemptDirectory = join(directory, id);
    mkdirSync(attemptDirectory); mkdirSync(join(attemptDirectory, 'phases'));
    const specification = { ...caseSpec, id, repetition, directory: attemptDirectory, timeoutMs: plan.timeoutMs };
    publish(join(attemptDirectory, 'specification.json'), specification);
    publish(join(attemptDirectory, 'launch.json'), { id, role, specificationHash: hash(specification), startedAt: new Date().toISOString() });
    const env = { ...process.env, NODE_OPTIONS: plan.runtime.nodeOptions, MEMORY_BENCHMARK_PHASE_DIRECTORY: join(attemptDirectory, 'phases'),
      ...(collector.executable ? { MEMORY_BENCHMARK_HELPER: collector.executable } : {}) };
    delete env.NODE_V8_COVERAGE;
    let measurement, workload = null, error = null, status;
    try {
      if (caseSpec.unavailableReason) throw Object.assign(new Error(caseSpec.unavailableReason), { code: 'BENCHMARK_FIXTURE_UNAVAILABLE' });
      measurement = await collect(collector, specification, { sampleMs: caseSpec.sampleMs ?? plan.sampleMs, budgetBytes: plan.budgetBytes, env, supervisor });
      if (existsSync(join(attemptDirectory, 'workload.json'))) workload = JSON.parse(readFileSync(join(attemptDirectory, 'workload.json'), 'utf8'));
      status = measurement.status === 'timeout' ? 'timeout' : measurement.status !== 'completed' ? 'collector-failed' :
        measurement.memoryEvents?.oom_kill > 0 ? 'confirmed-oom' : measurement.rootExitCode !== 0 || workload?.status !== 'completed' ? 'workload-failed' : 'completed';
      if (status === 'completed') {
        if (workload.results.length !== specification.jobs || workload.runtime.nodeOptions !== plan.runtime.nodeOptions) throw new Error('BENCHMARK_CORRECTNESS: population or runtime differs');
        verifyWorkload(workload, specification.configuration);
        if (specification.configuration.kind === 'replay') {
          const identity = hash(workload.results.map(row => ({ index: row.result.index, count: row.result.count, traceHash: row.result.traceHash,
            signalsHash: row.result.signalsHash, ledger: row.result.ledger })));
          const prior = identities.get(caseSpec.id);
          if (prior && prior !== identity) throw new Error('BENCHMARK_CORRECTNESS: replay identities changed between repetitions');
          identities.set(caseSpec.id, identity);
        }
      }
      if (hash(sources()) !== hash(sourceHashes)) throw new Error('BENCHMARK_SOURCE_CHANGED: benchmark implementation changed during study');
      verifiedRuntimeProvenance();
    } catch (failure) { status = failure.code === 'BENCHMARK_FIXTURE_UNAVAILABLE' ? 'fixture-unavailable' : 'invalid'; error = { code: failure.code ?? 'BENCHMARK_ERROR', message: failure.message }; }
    const result = { format: 'memory-benchmark-attempt-v1', id, caseId: caseSpec.id, repetition, role, status,
      specificationHash: hash(specification), scope: 'startup-through-publication-and-descendant-exit',
      metrics: [{ name: metricName, value: measurement?.[metricName] ?? null, unit: 'bytes', source: collector.source,
        kind: 'lifetime-high-water', coverage: measurement?.peakCoverage ?? 'incomplete' },
      { name: 'sampledTreeResidentPeakBytes', value: measurement?.sampledTreeResidentPeakBytes ?? null, unit: 'bytes',
        source: collector.source, kind: 'sampled-maximum', coverage: 'finite-polling; shared-pages-may-be-counted-more-than-once' }],
      measurement: measurement ?? null, workload, error, artifactHashes: artifactHashes(attemptDirectory) };
    publish(join(attemptDirectory, 'completion.json'), result); attempts.push(result);
    process.stderr.write(`[memory] ${id}: ${status}${measurement?.[metricName] ? ` ${(measurement[metricName] / 1048576).toFixed(1)} MiB` : ''}\n`);
    return result;
  }
  const fixtureKinds = ['replay', 'retention', 'checkpoint-restore'];
  for (const count of [...new Set(plan.cases.filter(row => fixtureKinds.includes(row.configuration.kind)).map(row => row.configuration.count))]) {
    let manifestPath = plan.datasetManifest;
    if (!manifestPath) {
      const prepared = await attempt({ id: `prepare-${count}`, jobs: 1, concurrency: 1, configuration: { kind: 'prepare', count } }, 0, 'preparation');
      if (prepared.status !== 'completed') continue;
      manifestPath = prepared.workload.results[0].result.manifestPath;
    }
    const data = openQuoteData(manifestPath);
    try {
      if (data.manifest.audit.streams.quotes.count !== count || hash(data.instrument) !== hash(instrument)) throw new Error('BENCHMARK_FIXTURE: fixture count/instrument differs');
      fixtures.set(count, { manifestPath: resolve(manifestPath), datasetHash: data.manifest.datasetHash,
        manifestHash: fileHash(manifestPath), databaseHash: data.manifest.audit.sha256, count });
    } finally { data.close(); }
  }
  publish(join(directory, 'fixtures.json'), [...fixtures.values()]);
  for (const caseSpec of resolvedCases.filter(row => row.configuration.kind === 'checkpoint-restore')) {
    const fixture = fixtures.get(caseSpec.configuration.count);
    if (!fixture) continue;
    const prepared = await attempt({ ...caseSpec, id: `checkpoint-${caseSpec.configuration.prefix}`, configuration: { ...caseSpec.configuration, ...fixture, kind: 'checkpoint-prepare' } }, 0, 'preparation');
    if (prepared.status === 'completed') caseSpec.configuration.checkpointPath = prepared.workload.results[0].result.checkpointPath;
  }
  const population = shuffled(resolvedCases.flatMap(caseSpec => Array.from({ length: plan.repetitions }, (_, repetition) => ({ caseSpec, repetition }))), plan.orderSeed);
  publish(join(directory, 'order.json'), population.map(row => ({ caseId: row.caseSpec.id, repetition: row.repetition })));
  for (const { caseSpec, repetition } of population) {
    const fixture = fixtures.get(caseSpec.configuration.count);
    if ((!fixture && fixtureKinds.includes(caseSpec.configuration.kind)) || (caseSpec.configuration.kind === 'checkpoint-restore' && !caseSpec.configuration.checkpointPath)) {
      await attempt({ ...caseSpec, unavailableReason: 'Fixture preparation did not complete' }, repetition); continue;
    }
    await attempt({ ...caseSpec, configuration: { ...caseSpec.configuration, ...fixture } }, repetition);
  }
  const cases = resolvedCases.map(caseSpec => {
    const rows = attempts.filter(row => row.role === 'measurement' && row.caseId === caseSpec.id), successes = rows.filter(row => row.status === 'completed');
    const total = (row, name) => row.workload.results.reduce((sum, job) => sum + (job.result.cycles ? job.result.cycles.reduce((n, cycle) => n + (cycle.result[name] ?? 0), 0) : (job.result[name] ?? 0)), 0);
    return { ...caseSpec, statuses: rows.map(row => row.status), attempts: rows.map(row => row.id), metric: metricName,
      peakBytes: statistics(successes.map(row => row.metrics[0].value)), elapsedMs: statistics(successes.map(row => Number(row.measurement.elapsedNs) / 1000000)),
      sampledResidentPeakBytes: statistics(successes.filter(row => row.metrics[1].value !== null).map(row => row.metrics[1].value)),
      observations: statistics(successes.map(row => total(row, 'observationCount'))), fills: statistics(successes.map(row => total(row, 'fills'))),
      auditBytes: statistics(successes.map(row => total(row, 'auditBytes'))),
      observationsPerSecond: statistics(successes.map(row => total(row, 'observationCount') / (Number(row.measurement.elapsedNs) / 1000000000))) };
  });
  const summary = { format: 'memory-benchmark-study-v1', status: attempts.every(row => row.status === 'completed') ? 'completed' : 'failed',
    outputDirectory: directory, planHash: hash(plan), plan, host, collector, cases, attempts,
    interpretation: 'Absolute platform-qualified memory demand. Local uncontrolled host; no improvement or tail-capacity claim. Preparation is separate. Natural GC; fresh group per repetition.' };
  publish(join(directory, 'summary.json'), summary);
  return summary;
}
