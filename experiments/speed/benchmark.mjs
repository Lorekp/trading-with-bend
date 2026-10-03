import { spawn, spawnSync } from 'node:child_process';
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { hash, canonical, requireThat } from '../../src/core.mjs';
import { pairSchedule, resolveProtocol } from './protocol.mjs';
import { summarizeComparison } from './statistics.mjs';

const harnessFiles = ['runner.mjs', 'worker.mjs', 'protocol.mjs', 'statistics.mjs', 'benchmark.mjs', 'quotes.json'];
const publish = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx', flush: true });
const fileHash = path => {
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try { let size; while ((size = readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
};
const controllerRoot = fileURLToPath(new URL('../../', import.meta.url));
const harnessIdentity = root => Object.fromEntries(harnessFiles.map(name => [name, fileHash(join(root, 'experiments/speed', name))]));
const controllerHarness = harnessIdentity(controllerRoot);
const gitIdentity = root => {
  const git = args => {
    const result = spawnSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return { commit: git(['rev-parse', 'HEAD']), trackedChanges: git(['status', '--porcelain', '--untracked-files=no']) };
};

async function invoke(root, directory, request, environment, timeoutMs) {
  mkdirSync(directory, { recursive: true });
  const requestPath = join(directory, 'request.json'), responsePath = join(directory, 'response.json');
  publish(requestPath, { ...request, responsePath });
  const startedAt = new Date().toISOString(), start = performance.now();
  const child = spawn(process.execPath, [join(root, 'experiments/speed/runner.mjs'), requestPath], {
    cwd: root, env: environment, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let timedOut = false, spawnError, logError;
  const logs = [pipeline(child.stdout, createWriteStream(join(directory, 'stdout.log'), { flags: 'wx' })),
    pipeline(child.stderr, createWriteStream(join(directory, 'stderr.log'), { flags: 'wx' }))].map(promise => promise.catch(error => { logError = error; }));
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
    }
    child.stdout.destroy(); child.stderr.destroy();
  }, timeoutMs);
  const { code, signal } = await new Promise(resolveExit => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  const jobWallMs = performance.now() - start;
  clearTimeout(timer);
  await Promise.all(logs);
  let response;
  try { response = JSON.parse(readFileSync(responsePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const error = timedOut ? { code: 'BENCHMARK_TIMEOUT', message: `Runner exceeded ${timeoutMs} ms` } :
    spawnError || logError ? { code: 'BENCHMARK_PROCESS', message: (spawnError ?? logError).message } : response?.error;
  return { status: code === 0 && !error ? 'completed' : 'failed', startedAt, finishedAt: new Date().toISOString(),
    jobWallMs, runnerPid: child.pid ?? null, exitCode: code, signal, response, ...(error ? { error } : {}) };
}

/** One interface owns process comparisons, complete evidence and inference. */
export async function runBenchmark(input, { baselineRoot, candidateRoot, outputDirectory }) {
  const protocol = resolveProtocol(input), roots = { baseline: resolve(baselineRoot), candidate: resolve(candidateRoot) };
  const output = resolve(outputDirectory);
  requireThat(canonical(harnessIdentity(controllerRoot)) === canonical(controllerHarness),
    'BENCHMARK_HARNESS_CHANGED', 'Controller changed after loading; restart the process');
  const harnesses = { controller: controllerHarness,
    ...Object.fromEntries(Object.entries(roots).map(([target, root]) => [target, harnessIdentity(root)])) };
  requireThat(Object.values(harnesses).every(harness => canonical(harness) === canonical(harnesses.controller)),
    'BENCHMARK_HARNESS', 'Controller and targets require identical benchmark harnesses');
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output, { recursive: false });
  const environment = { ...process.env, NODE_OPTIONS: `--max-old-space-size=${protocol.heapMiB}` };
  const protocolPath = join(output, 'protocol.json'), schedule = pairSchedule(protocol);
  const targets = {}, datasets = {}, preflightDatasets = {}, samples = [];
  const cpus = os.cpus();
  const host = { platform: process.platform, architecture: process.arch, os: os.version(), release: os.release(),
    cpu: cpus[0]?.model ?? null, logicalCores: cpus.length, ramBytes: os.totalmem(), nodeExecutable: process.execPath,
    node: process.version, v8: process.versions.v8, nodeOptions: environment.NODE_OPTIONS,
    storagePath: output, filesystem: 'unknown', affinity: 'unknown', powerMode: 'unknown', cachePolicy: protocol.cachePolicy };
  const resolved = { ...protocol, host, roots, harnesses, schedule, datasets };
  try {
    for (const [target, root] of Object.entries(roots)) {
      const identity = await invoke(root, join(output, 'identity', target), { action: 'identity' }, environment, protocol.timeoutMs);
      requireThat(identity.status === 'completed', 'BENCHMARK_BUILD', `${target} preflight failed: ${identity.response?.error?.message ?? identity.error?.message}`);
      targets[target] = { ...identity.response, ...gitIdentity(root), harness: harnesses[target] };
    }
    for (const caseId of protocol.cases) {
      for (const [group, count, collection] of [['data', protocol.ticks, datasets], ['preflight-data', Math.min(1024, protocol.ticks), preflightDatasets]]) {
        const preparation = await invoke(roots.baseline, join(output, 'preparation', group, caseId), {
          action: 'prepare', caseId, quoteParameters: protocol.quoteParameters[caseId], instrument: protocol.instrument,
          count, seed: protocol.datasetSeed, directory: join(output, group, caseId),
        }, environment, protocol.timeoutMs);
        requireThat(preparation.status === 'completed', 'BENCHMARK_DATA', `Preparation failed: ${preparation.response?.error?.message ?? preparation.error?.message}`);
        const data = preparation.response;
        collection[caseId] = { ...data, manifestFileHash: fileHash(data.manifestPath), dataFileHash: fileHash(data.file) };
      }
    }
    publish(protocolPath, protocol);
    publish(join(output, 'run.json'), resolved);
    publish(join(output, 'targets.json'), targets);
    const runHash = hash(resolved);
    const attempt = async (caseId, pair, target, stage, dataset) => {
      const directory = join(output, 'attempts', stage, caseId, String(pair), target), registry = join(directory, 'registry');
      const key = `speed/${runHash}/${hash(targets[target].sources)}/${caseId}/${stage}/${pair}/${target}`;
      // A bounded pre-read outside timing; this makes no cache-residency promise.
      for await (const chunk of createReadStream(dataset.file)) void chunk;
      const execution = await invoke(roots[target], join(directory, 'execution'), { action: 'run', registry, key, protocolPath,
        timeoutMs: protocol.timeoutMs - 10000,
        configuration: { manifestPath: dataset.manifestPath, inputHash: dataset.inputHash, count: dataset.count, caseId,
          seed: protocol.datasetSeed, orderEvery: protocol.orderEvery, lookback: protocol.lookback, execution: protocol.execution,
          traceMode: protocol.traceMode, orderStorage: protocol.orderStorage, reportDetail: protocol.reportDetail },
      }, environment, protocol.timeoutMs);
      const row = { caseId, pair, target, stage, inputHash: dataset.inputHash, seed: protocol.datasetSeed,
        status: execution.status, jobWallMs: execution.jobWallMs, startedAt: execution.startedAt, finishedAt: execution.finishedAt,
        runnerPid: execution.runnerPid, exitCode: execution.exitCode, signal: execution.signal, registry, key,
        ...(execution.error ? { error: execution.error } : {}) };
      if (row.status === 'completed') {
        try {
          requireThat(execution.response.sourceHash === hash(targets[target].sources), 'BENCHMARK_SOURCE_CHANGED', 'Target source changed during campaign');
          const inspection = await invoke(roots[target], join(directory, 'inspection'), { action: 'inspect', registry, key,
            artifacts: execution.response.attempt.outputDirectory, count: dataset.count, orderEvery: protocol.orderEvery,
          }, environment, protocol.timeoutMs);
          requireThat(inspection.status === 'completed', 'BENCHMARK_EVIDENCE', inspection.response?.error?.message ?? inspection.error?.message ?? 'Evidence inspection failed');
          const runtime = inspection.response.result.runtime;
          const settings = inspection.response.result.workload;
          requireThat(canonical(settings) === canonical({ caseId, count: dataset.count, seed: protocol.datasetSeed,
            inputHash: dataset.inputHash, instrument: protocol.instrument, execution: protocol.execution,
            orderEvery: protocol.orderEvery, lookback: protocol.lookback, traceMode: protocol.traceMode,
            orderStorage: protocol.orderStorage, reportDetail: protocol.reportDetail }),
          'BENCHMARK_WORKLOAD', 'Effective worker workload differs from protocol');
          requireThat(runtime.node === targets[target].node && runtime.v8 === targets[target].v8 && runtime.nodeOptions === environment.NODE_OPTIONS &&
            runtime.heapLimitBytes >= protocol.heapMiB * 1048576, 'BENCHMARK_RUNTIME', 'Measured worker runtime or heap policy differs');
          Object.assign(row, { evidenceHash: inspection.response.evidenceHash, metrics: inspection.response.result,
            buys: inspection.response.buys, sells: inspection.response.sells, cancellations: inspection.response.cancellations,
            workerPid: execution.response.attempt.workerPid });
        } catch (error) { row.status = 'failed'; row.error = { code: error.code ?? 'BENCHMARK_ERROR', message: error.message }; }
      } else if (!row.error) row.error = execution.response?.attempt?.error ?? execution.response?.error ?? { code: 'BENCHMARK_PROCESS', message: 'Runner did not complete' };
      samples.push(row);
      publish(join(directory, 'sample.json'), row);
      console.error(`${stage} ${caseId} pair ${pair + 1}/${stage === 'measurement' ? protocol.pairs : 1} ${target}: ${row.status} ${row.jobWallMs.toFixed(1)} ms`);
      return row;
    };
    for (const caseId of protocol.cases) {
      const b = await attempt(caseId, 0, 'baseline', 'preflight', preflightDatasets[caseId]);
      const c = await attempt(caseId, 0, 'candidate', 'preflight', preflightDatasets[caseId]);
      requireThat(b.status === 'completed' && c.status === 'completed' && b.evidenceHash === c.evidenceHash,
        'BENCHMARK_PREFLIGHT', `Preflight equivalence failed for ${caseId}`);
    }
    for (const entry of schedule) {
      const members = [];
      for (const target of entry.order) members.push(await attempt(entry.caseId, entry.pair, target, 'measurement', datasets[entry.caseId]));
      if (members.every(row => row.status === 'completed') && members[0].evidenceHash !== members[1].evidenceHash) {
        publish(join(output, 'attempts', 'measurement', entry.caseId, String(entry.pair), 'mismatch.json'),
          { code: 'BENCHMARK_MISMATCH', message: 'Paired complete execution evidence differs', members: members.map(row => ({ target: row.target, evidenceHash: row.evidenceHash })) });
      }
    }
    for (const collection of [datasets, preflightDatasets]) for (const data of Object.values(collection)) {
      requireThat(fileHash(data.manifestPath) === data.manifestFileHash && fileHash(data.file) === data.dataFileHash,
        'BENCHMARK_INPUT_CHANGED', 'Input bytes changed during campaign');
    }
    for (const name of harnessFiles) requireThat(fileHash(join(controllerRoot, 'experiments/speed', name)) === harnesses.controller[name],
      'BENCHMARK_HARNESS_CHANGED', 'Controller harness changed during campaign');
    for (const [target, root] of Object.entries(roots)) {
      const identity = await invoke(root, join(output, 'final-identity', target), { action: 'identity' }, environment, protocol.timeoutMs);
      requireThat(identity.status === 'completed' && canonical(identity.response) === canonical(targets[target] && {
        sources: targets[target].sources, verification: targets[target].verification, node: targets[target].node,
        v8: targets[target].v8, nodeOptions: targets[target].nodeOptions,
      }), 'BENCHMARK_SOURCE_CHANGED', 'Toolkit identity changed during campaign');
      for (const name of harnessFiles) requireThat(fileHash(join(root, 'experiments/speed', name)) === harnesses[target][name],
        'BENCHMARK_HARNESS_CHANGED', 'Harness changed during campaign');
    }
  } catch (error) {
    const failure = { code: error.code ?? 'BENCHMARK_ERROR', message: error.message };
    publish(join(output, 'samples.json'), samples);
    const report = { schema: 'speed-benchmark-report-v1', status: 'incomplete', outputDirectory: output, protocol: resolved,
      targets, failure, comparisons: summarizeComparison(protocol, samples).map(row => ({ ...row, eligibleForInference: false, conclusion: 'incomplete', diagnosticOnly: true })) };
    publish(join(output, 'summary.json'), report);
    return report;
  }
  publish(join(output, 'samples.json'), samples);
  const comparisons = summarizeComparison(protocol, samples);
  const report = { schema: 'speed-benchmark-report-v1', status: comparisons.every(row => row.completedPairs === protocol.pairs) ? 'completed' : 'incomplete',
    outputDirectory: output, protocol: resolved, protocolHash: hash(protocol), runHash: hash(resolved), targets,
    comparisonType: canonical(targets.baseline.sources) === canonical(targets.candidate.sources) ? 'A/A' : 'baseline/candidate',
    scope: 'fresh-process single-job completion including durable evidence publication', comparisons };
  publish(join(output, 'summary.json'), report);
  return report;
}
