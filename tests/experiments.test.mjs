import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { cancelExperiment, canonicalExperimentJson, deterministicSeed, enqueueExperiment, listExperiments, queueStatus, recoverQueue, readExperimentResult, recoverExperiment, runExperiment, runQueue, verifyExperimentArtifacts, writeExperimentArtifact } from '../src/experiments.mjs';

const api = new URL('../src/experiments.mjs', import.meta.url).href;

test('legacy inline registries fail explicitly instead of silently omitting their trials', t => {
  const { registry, worker } = fixture(t);
  mkdirSync(registry);
  const path = join(registry, '11111111-1111-4111-8111-111111111111.json'), record = '{"status":"failed"}';
  writeFileSync(path, record);
  assert.throws(() => listExperiments(registry), { code: 'REGISTRY_VERSION' });
  assert.throws(() => runExperiment(registry, {}, () => assert.fail('Must not execute')), { code: 'REGISTRY_VERSION' });
  assert.throws(() => enqueueExperiment(registry, { key: 'new', configuration: {}, workerModule: worker }), { code: 'REGISTRY_VERSION' });
  assert.equal(readFileSync(path, 'utf8'), record);
  assert.deepEqual(readdirSync(registry), [path.split(/[\\/]/).at(-1)]);
});

test('inline and queued work share registration, immutable artifacts and verified result retrieval', async t => {
  const { registry, worker } = fixture(t);
  let retained;
  const configuration = { trial: 'success' };
  const completed = runExperiment(registry, configuration, (snapshot, context) => {
    retained = context;
    assert.ok(Object.isFrozen(context));
    assert.deepEqual(snapshot, configuration);
    snapshot.trial = 'callback mutation';
    context.writeArtifact('metrics.json', { score: 42 });
    assert.equal(listExperiments(registry)[0].status, 'running');
    assert.throws(() => recoverExperiment(registry, context.key), { code: 'OWNER_ALIVE' });
    return 42;
  });
  assert.deepEqual(configuration, { trial: 'success' });
  assert.equal(retained.key, completed.id);
  assert.equal(readExperimentResult(registry, completed.id), 42);
  assert.deepEqual(Object.keys(verifyExperimentArtifacts(registry, completed.id)), ['metrics.json']);
  assert.throws(() => retained.writeArtifact('late.json', {}), { code: 'ATTEMPT_FINISHED' });
  assert.throws(() => runExperiment(registry, { trial: 'failure' }, () => { throw new Error('failed trial'); }), /failed trial/);
  enqueueExperiment(registry, { key: 'queued', configuration: {}, workerModule: worker });
  const records = listExperiments(registry);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(record => record.status).sort(), ['completed', 'failed', 'queued']);
  assert.equal(records.find(record => record.key === completed.id).attempts[0].status, 'completed');
  assert.deepEqual(records.find(record => record.key === completed.id).configuration, configuration);
  const listed = await subprocess([fileURLToPath(cli), 'status', registry]).done;
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), records);
  await runQueue(registry);
  assert.deepEqual(readExperimentResult(registry, 'queued'), { configuration: {}, seed: deterministicSeed('queued') });
  assert.equal(readExperimentResult(registry, completed.id), 42);
  const finished = listExperiments(registry).find(record => record.key === completed.id).attempts[0];
  writeFileSync(finished.resultPath, '99');
  assert.throws(() => readExperimentResult(registry, completed.id), { code: 'RESULT_CHANGED' });
});

test('inline invalid results and synchronous or asynchronous errors retain failed attempts', async t => {
  const { registry } = fixture(t);
  for (const [work, code] of [
    [() => ({ score: NaN }), 'INVALID_JSON'],
    [() => { throw undefined; }, 'WORKER_ERROR'],
    [() => { throw false; }, 'WORKER_ERROR'],
    [async () => { throw new Error('async rejection'); }, 'ASYNC_EXPERIMENT'],
  ]) {
    const before = new Set(listExperiments(registry).map(job => job.key));
    let returned = false;
    try { runExperiment(registry, {}, work); returned = true; } catch {}
    assert.equal(returned, false);
    const job = listExperiments(registry).find(job => !before.has(job.key));
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts[0].error.code, code);
    assert.throws(() => readExperimentResult(registry, job.key), { code: 'RESULT_UNAVAILABLE' });
  }
  await delay(0); // Async rejection is consumed; it cannot escape the recorded failure.
});
const cli = new URL('../src/experiments-cli.mjs', import.meta.url);
function fixture(t, code = 'export default async (configuration, context) => ({ configuration, seed: context.seed });') {
  const root = mkdtempSync(join(tmpdir(), 'bend-experiments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, code);
  return { root, worker, registry: join(root, 'registry') };
}
function subprocess(args, options = {}) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { child, done };
}
const runProcess = code => subprocess(['--input-type=module', '-e', code]);
async function eventually(predicate, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (predicate()) return; await delay(5); }
  assert.fail('Timed out waiting for an observable process state');
}

test('manifest idempotency is canonical, collisions retain the original, seeds depend only on key', async t => {
  const { registry, worker } = fixture(t);
  const first = enqueueExperiment(registry, { key: 'agent-a/model', configuration: { b: 2, a: 1 }, workerModule: worker });
  const again = enqueueExperiment(registry, { key: 'agent-a/model', configuration: { a: 1, b: 2 }, workerModule: pathToFileURL(worker) });
  assert.deepEqual(again, first);
  assert.equal(first.seed, deterministicSeed('agent-a/model'));
  assert.throws(() => enqueueExperiment(registry, { key: first.key, configuration: { a: 2 }, workerModule: worker }), { code: 'EXPERIMENT_COLLISION' });
  assert.throws(() => enqueueExperiment(registry, { key: first.key, configuration: first.configuration, workerModule: worker, seed: first.seed ^ 1 }), { code: 'EXPERIMENT_COLLISION' });
  assert.equal(listExperiments(registry).length, 1);
  assert.equal(listExperiments(registry)[0].status, 'queued');
  for (const invalid of [undefined, NaN, Infinity, -0, 1n, new Date(), { a: undefined }, [, 1]]) {
    assert.throws(() => canonicalExperimentJson(invalid), { code: 'INVALID_JSON' });
  }
  await assert.rejects(runQueue(registry, { concurrency: 0 }), { code: 'INVALID_CONCURRENCY' });
  await assert.rejects(runQueue(registry, { timeoutMs: 0 }), { code: 'INVALID_TIMEOUT' });
});

test('independent enqueue processes publish exactly one immutable manifest', async t => {
  const { registry, worker } = fixture(t);
  const input = { key: 'same-key', configuration: { x: 1 }, workerModule: worker };
  const command = `import { enqueueExperiment } from ${JSON.stringify(api)}; process.stdout.write(JSON.stringify(enqueueExperiment(${JSON.stringify(registry)}, ${JSON.stringify(input)})));`;
  const results = await Promise.all(Array.from({ length: 4 }, () => runProcess(command).done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  for (const result of results) assert.deepEqual(JSON.parse(result.stdout), JSON.parse(results[0].stdout));
  assert.equal(listExperiments(registry).length, 1);
});

test('two queue processes execute each job once with real bounded concurrent work and deterministic results', async t => {
  const code = `
import { writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export default async (configuration, context) => {
  writeFileSync(join(configuration.executed, context.key), String(process.pid), { flag: 'wx' });
  const active = join(configuration.active, context.key);
  writeFileSync(active, String(process.pid), { flag: 'wx' });
  const count = readdirSync(configuration.active).length;
  if (count > 4) throw new Error('Concurrency exceeded four workers across two queues');
  while (!existsSync(configuration.release)) await delay(2);
  await delay(2);
  context.writeArtifact('metrics.json', { seed: context.seed, key: context.key });
  unlinkSync(active);
  return { seed: context.seed, key: context.key };
};`;
  const { registry, worker, root } = fixture(t, code);
  const active = join(root, 'active'), executed = join(root, 'executed'), release = join(root, 'release');
  mkdirSync(active); mkdirSync(executed);
  for (let i = 9; i >= 0; i--) enqueueExperiment(registry, { key: `job-${i}`, configuration: { active, executed, release }, workerModule: worker });
  const command = `import { runQueue } from ${JSON.stringify(api)}; await runQueue(${JSON.stringify(registry)}, { concurrency: 2, timeoutMs: 15000 });`;
  const runners = [runProcess(command), runProcess(command)];
  t.after(() => { for (const runner of runners) runner.child.kill(); });
  await eventually(() => readdirSync(active).length === 4);
  assert.equal(readdirSync(active).length, 4, 'Four strategy callbacks are simultaneously executing');
  assert.throws(() => recoverExperiment(registry, listExperiments(registry).find(job => job.status === 'running').key), { code: 'OWNER_ALIVE' });
  writeFileSync(release, 'go');
  const results = await Promise.all(runners.map(runner => runner.done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(readdirSync(executed).length, 10);
  assert.equal(readdirSync(active).length, 0);
  const jobs = listExperiments(registry);
  assert.deepEqual(jobs.map(job => job.key), Array.from({ length: 10 }, (_, i) => `job-${i}`));
  for (const job of jobs) {
    assert.equal(job.status, 'completed', JSON.stringify(job.attempts));
    assert.equal(job.attempts.length, 1);
    assert.deepEqual(readExperimentResult(registry, job.key), { key: job.key, seed: deterministicSeed(job.key) });
    assert.deepEqual(JSON.parse(readFileSync(join(job.attempts[0].outputDirectory, 'metrics.json'), 'utf8')), { key: job.key, seed: job.seed });
  }
  await runQueue(registry, { concurrency: 3 });
  assert.equal(readdirSync(executed).length, 10, 'Completed jobs are never silently rerun');
});

test('async rejection, invalid result, exit, timeout and successful output remain in aggregation', async t => {
  const { registry, worker } = fixture(t, `
export default async configuration => {
  if (configuration.mode === 'reject') { await Promise.resolve(); throw Object.assign(new Error('Rejected after await'), { code: 'MODEL_FAILED' }); }
  if (configuration.mode === 'invalid') return { score: NaN };
  if (configuration.mode === 'empty-rejection') await Promise.reject();
  if (configuration.mode === 'throw-false') throw false;
  if (configuration.mode === 'exit') process.exit(9);
  if (configuration.mode === 'hang') await new Promise(resolve => setInterval(resolve, 100000));
  return { score: 7 };
};`);
  for (const mode of ['reject', 'invalid', 'empty-rejection', 'throw-false', 'exit', 'hang', 'success']) enqueueExperiment(registry, { key: mode, configuration: { mode }, workerModule: worker });
  const jobs = await runQueue(registry, { concurrency: 5, timeoutMs: 1800 });
  assert.equal(jobs.length, 7);
  const expected = { reject: 'MODEL_FAILED', invalid: 'INVALID_JSON', 'empty-rejection': 'WORKER_ERROR', 'throw-false': 'WORKER_ERROR', exit: 'WORKER_CRASH', hang: 'WORKER_TIMEOUT' };
  for (const job of jobs) {
    if (job.key === 'success') { assert.equal(job.status, 'completed'); continue; }
    assert.equal(job.status, 'failed', JSON.stringify(job));
    assert.equal(job.attempts[0].error.code, expected[job.key]);
    assert.throws(() => readExperimentResult(registry, job.key), { code: 'RESULT_UNAVAILABLE' });
  }
  assert.throws(() => recoverExperiment(registry, 'reject'), { code: 'NOT_ABANDONED' });
});

test('startup timeouts are terminal records even if child cannot reach its claim', async t => {
  const { registry, worker } = fixture(t);
  enqueueExperiment(registry, { key: 'short-timeout', configuration: {}, workerModule: worker });
  const [job] = await runQueue(registry, { timeoutMs: 1 });
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts[0].error.code, 'WORKER_TIMEOUT');
});

test('changed worker and declared dataset refuse execution and result tampering is detected', async t => {
  const { registry, worker, root } = fixture(t);
  enqueueExperiment(registry, { key: 'worker-changed', configuration: {}, workerModule: worker });
  writeFileSync(worker, 'export default () => ({ score: 1 });');
  const dataset = join(root, 'dataset.json'); writeFileSync(dataset, '[1,2]');
  enqueueExperiment(registry, { key: 'data-changed', configuration: {}, workerModule: worker, dependencies: [dataset] });
  writeFileSync(dataset, '[3,4]');
  enqueueExperiment(registry, { key: 'successful', configuration: {}, workerModule: worker });
  const jobs = await runQueue(registry, { concurrency: 3 });
  assert.equal(jobs.find(job => job.key === 'worker-changed').attempts[0].error.code, 'WORKER_CHANGED');
  assert.equal(jobs.find(job => job.key === 'data-changed').attempts[0].error.code, 'DEPENDENCY_CHANGED');
  const successful = jobs.find(job => job.key === 'successful');
  assert.deepEqual(readExperimentResult(registry, successful.key), { score: 1 });
  writeFileSync(successful.attempts[0].resultPath, '{"score":999}');
  assert.throws(() => readExperimentResult(registry, successful.key), { code: 'RESULT_CHANGED' });
});

test('manifest edits cannot execute or be accepted under an unchanged specification hash', async t => {
  const { registry, worker } = fixture(t);
  const specification = { key: 'manifest-tamper', configuration: { score: 1 }, workerModule: worker };
  enqueueExperiment(registry, specification);
  const directory = readdirSync(join(registry, 'jobs'))[0];
  const path = join(registry, 'jobs', directory, 'manifest.json');
  const changed = JSON.parse(readFileSync(path, 'utf8'));
  changed.configuration.score = 999;
  writeFileSync(path, JSON.stringify(changed));
  assert.throws(() => listExperiments(registry), { code: 'REGISTRY_CORRUPT' });
  assert.throws(() => enqueueExperiment(registry, specification), { code: 'REGISTRY_CORRUPT' });
  await assert.rejects(runQueue(registry), { code: 'REGISTRY_CORRUPT' });
});

for (const execution of ['inline', 'worker']) test(`${execution} binary models and JSON metrics are checked for edits, additions and deletion`, async t => {
  const { registry, worker } = fixture(t, `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default (configuration, context) => {
  context.writeArtifact('metrics.json', { score: 7 });
  writeFileSync(join(context.outputDirectory, 'model.bin'), Buffer.from([0, 1, 2, 255]));
  return { score: 7 };
};`);
  let key;
  if (execution === 'inline') key = runExperiment(registry, {}, (await import(pathToFileURL(worker).href)).default).id;
  else { key = 'model'; enqueueExperiment(registry, { key, configuration: {}, workerModule: worker }); }
  const [job] = await runQueue(registry);
  const directory = job.attempts[0].outputDirectory;
  assert.deepEqual(Object.keys(verifyExperimentArtifacts(registry, key)).sort(), ['metrics.json', 'model.bin']);
  writeFileSync(join(directory, 'model.bin'), Buffer.from([3, 4]));
  assert.throws(() => readExperimentResult(registry, key), { code: 'ARTIFACT_CHANGED' });
  writeFileSync(join(directory, 'model.bin'), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(directory, 'extra.json'), '{}');
  assert.throws(() => verifyExperimentArtifacts(registry, key), { code: 'ARTIFACT_CHANGED' });
  rmSync(join(directory, 'extra.json'));
  rmSync(join(directory, 'metrics.json'));
  assert.throws(() => verifyExperimentArtifacts(registry, key), { code: 'ARTIFACT_CHANGED' });
});

test('concurrent recovery closes a dead inline owner and preserves its artifacts without queueing its closure', async t => {
  const { registry } = fixture(t);
  const runner = runProcess(`import { runExperiment } from ${JSON.stringify(api)};
    runExperiment(${JSON.stringify(registry)}, { trial: 'interrupted' }, (configuration, context) => {
      context.writeArtifact('partial.json', configuration);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });`);
  t.after(() => runner.child.kill());
  await eventually(() => {
    const attempt = listExperiments(registry)[0]?.attempts[0];
    return attempt && existsSync(join(attempt.outputDirectory, 'partial.json'));
  });
  const [running] = listExperiments(registry), attempt = running.attempts[0];
  assert.equal(attempt.workerPid, runner.child.pid);
  assert.equal(attempt.supervisorPid, runner.child.pid);
  assert.throws(() => recoverExperiment(registry, running.key), { code: 'OWNER_ALIVE' });
  assert.equal((await runQueue(registry))[0].status, 'running');
  runner.child.kill(); await runner.done;
  const recoveries = await Promise.all([0, 1].map(() => subprocess([fileURLToPath(cli), 'recover', registry, running.key]).done));
  for (const recovery of recoveries) {
    assert.equal(recovery.code, 0, recovery.stderr);
    assert.equal(JSON.parse(recovery.stdout).status, 'abandoned');
  }
  const [abandoned] = await runQueue(registry);
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.attempts.length, 1);
  assert.equal(abandoned.attempts[0].token, attempt.token);
  assert.deepEqual(JSON.parse(readFileSync(join(attempt.outputDirectory, 'partial.json'), 'utf8')), { trial: 'interrupted' });
  assert.throws(() => readExperimentResult(registry, running.key), { code: 'RESULT_UNAVAILABLE' });
  const fresh = runExperiment(registry, running.configuration, () => ({ retried: true }));
  assert.notEqual(fresh.id, running.key);
  assert.deepEqual(listExperiments(registry).map(job => job.status).sort(), ['abandoned', 'completed']);
});

test('killed supervisor and worker require explicit recovery, preserving failed attempt history', async t => {
  const { registry, worker, root } = fixture(t, `
import { existsSync } from 'node:fs';
export default async configuration => {
  if (!existsSync(configuration.release)) await new Promise(() => setInterval(() => {}, 1000));
  return { recovered: true };
};`);
  const release = join(root, 'release');
  enqueueExperiment(registry, { key: 'abandoned', configuration: { release }, workerModule: worker });
  const runner = runProcess(`import { runQueue } from ${JSON.stringify(api)}; await runQueue(${JSON.stringify(registry)}, { timeoutMs: 30000 });`);
  let workerPid;
  t.after(() => { runner.child.kill(); if (workerPid) { try { process.kill(workerPid); } catch {} } });
  await eventually(() => listExperiments(registry)[0]?.status === 'running');
  const running = listExperiments(registry)[0];
  workerPid = running.attempts[0].workerPid;
  runner.child.kill(); await runner.done;
  let workerAlive = true;
  try { process.kill(workerPid, 0); } catch { workerAlive = false; }
  // Some Windows process/job configurations terminate the child together with
  // its supervisor. Where an orphan survives, it must remain unclaimable.
  if (workerAlive) {
    assert.throws(() => recoverExperiment(registry, 'abandoned'), { code: 'OWNER_ALIVE' }, 'Live orphaned workers cannot be stolen');
    process.kill(workerPid);
  }
  await eventually(() => { try { process.kill(workerPid, 0); return false; } catch { return true; } });
  const unclaimed = await runQueue(registry);
  assert.equal(unclaimed[0].status, 'running', 'No automatic retry of abandoned claims');
  // Simulate a recovery process dying after its terminal marker but before
  // publishing the next-generation authorization.
  const attempt = running.attempts[0];
  writeFileSync(join(attempt.outputDirectory, '..', 'finished.json'), JSON.stringify({ token: attempt.token, status: 'abandoned', finishedAt: new Date().toISOString(), error: { code: 'ABANDONED', message: 'Interrupted recovery' } }), { flag: 'wx' });
  assert.equal(listExperiments(registry)[0].status, 'abandoned');
  const recovered = recoverExperiment(registry, 'abandoned');
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.attempts[0].status, 'abandoned');
  writeFileSync(release, 'go');
  const [completed] = await runQueue(registry);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attempts.length, 2);
  assert.notEqual(completed.attempts[0].token, completed.attempts[1].token);
  assert.notEqual(completed.attempts[0].outputDirectory, completed.attempts[1].outputDirectory);
  assert.equal(completed.attempts[0].status, 'abandoned');
  assert.deepEqual(readExperimentResult(registry, 'abandoned'), { recovered: true });
});

test('inherited stdout in a worker descendant cannot leave the queue waiting without a bound', async t => {
  const { registry, worker, root } = fixture(t, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
export default configuration => {
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', process.stdout, process.stderr], windowsHide: true });
  writeFileSync(configuration.pidFile, String(helper.pid));
  return { finished: true };
};`);
  const pidFile = join(root, 'helper.pid');
  let helperPid;
  t.after(() => { if (helperPid) { try { process.kill(helperPid); } catch {} } });
  enqueueExperiment(registry, { key: 'inherited-pipes', configuration: { pidFile }, workerModule: worker });
  const started = Date.now();
  const [job] = await runQueue(registry, { timeoutMs: 1200 });
  helperPid = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(job.status, 'completed', JSON.stringify(job));
  assert.ok(Date.now() - started < 6000, 'Timeout must bound waiting for inherited handles');
});

test('artifact paths stay inside attempt and existing artifacts cannot be overwritten', t => {
  const { root } = fixture(t);
  const artifacts = join(root, 'artifacts');
  const path = writeExperimentArtifact(artifacts, 'nested/metrics.json', { score: 1 });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { score: 1 });
  assert.throws(() => writeExperimentArtifact(artifacts, 'nested/metrics.json', { score: 2 }), { code: 'ARTIFACT_EXISTS' });
  assert.throws(() => writeExperimentArtifact(artifacts, '../escape.json', {}), { code: 'ARTIFACT_PATH' });
  assert.throws(() => writeExperimentArtifact(artifacts, resolve(root, 'absolute.json'), {}), { code: 'ARTIFACT_PATH' });
});

test('CLI enqueues, works and reports machine-readable records', async t => {
  const { registry, worker, root } = fixture(t);
  const input = join(root, 'jobs.json');
  writeFileSync(input, JSON.stringify({ key: 'cli', configuration: { x: 1 }, workerModule: worker }));
  const queued = await subprocess([fileURLToPath(cli), 'enqueue', registry, input]).done;
  assert.equal(queued.code, 0, queued.stderr);
  assert.equal(JSON.parse(queued.stdout)[0].key, 'cli');
  const worked = await subprocess([fileURLToPath(cli), 'work', registry]).done;
  assert.equal(worked.code, 0, worked.stderr);
  assert.equal(JSON.parse(worked.stdout)[0].status, 'completed');
  const status = await subprocess([fileURLToPath(cli), 'status', registry]).done;
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout)[0].status, 'completed');
});


test('shared admission budgets bound independent runners and resource declarations are immutable', async t => {
  const { registry, worker, root } = fixture(t, `
import { writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export default async (configuration, context) => {
  const marker = join(configuration.active, context.key);
  writeFileSync(marker, String(process.pid), { flag: 'wx' });
  if (readdirSync(configuration.active).length > 2) throw new Error('Shared budget exceeded');
  context.reportProgress({ stage: 'waiting' });
  while (!existsSync(configuration.release)) await delay(5);
  unlinkSync(marker);
  return { threads: process.env.OMP_NUM_THREADS };
}`);
  const active = join(root, 'active'), release = join(root, 'release'); mkdirSync(active);
  const resourceBudget = { workers: 2, cpuThreads: 4, memoryMiB: 256 };
  for (let i = 0; i < 6; i++) enqueueExperiment(registry, { key: `shared-${i}`, configuration: { active, release }, workerModule: worker, resources: { cpuThreads: 2, memoryMiB: 128 } });
  assert.throws(() => enqueueExperiment(registry, { key: 'shared-0', configuration: { active, release }, workerModule: worker, resources: { cpuThreads: 1, memoryMiB: 128 } }), { code: 'EXPERIMENT_COLLISION' });
  const command = `import { runQueue } from ${JSON.stringify(api)}; await runQueue(${JSON.stringify(registry)}, { concurrency: 4, resourceBudget: ${JSON.stringify(resourceBudget)}, timeoutMs: 15000 });`;
  const runners = [runProcess(command), runProcess(command)];
  t.after(() => { for (const runner of runners) runner.child.kill(); });
  await eventually(() => readdirSync(active).length === 2);
  await delay(100);
  assert.equal(readdirSync(active).length, 2);
  assert.deepEqual(queueStatus(registry).reserved, { workers: 2, cpuThreads: 4, memoryMiB: 256 });
  assert.ok(listExperiments(registry).filter(job => job.status === 'running').every(job => job.attempts[0].telemetry.progress.stage === 'waiting'));
  writeFileSync(release, 'go');
  for (const result of await Promise.all(runners.map(runner => runner.done))) assert.equal(result.code, 0, result.stderr);
  assert.equal(queueStatus(registry).reserved.workers, 0);
  for (const job of listExperiments(registry)) { assert.equal(job.status, 'completed'); assert.equal(readExperimentResult(registry, job.key).threads, '2'); }
  await assert.rejects(runQueue(registry, { resourceBudget: { workers: 3, cpuThreads: 4, memoryMiB: 256 } }), { code: 'BUDGET_COLLISION' });
});

test('continuous submission, durable cancellation, output quotas, and abort shutdown cross the runner interface', async t => {
  const { registry, worker } = fixture(t, `
import { setTimeout as delay } from 'node:timers/promises';
export default async (configuration, context) => {
  context.reportProgress({ started: true });
  if (configuration.mode === 'result') return { value: 'x'.repeat(4096) };
  if (configuration.mode === 'log') console.log('x'.repeat(4096));
  if (configuration.mode === 'artifact') context.writeArtifact('large.json', { value: 'x'.repeat(4096) });
  if (configuration.mode === 'hang') await new Promise(() => setInterval(() => {}, 1000));
  await delay(40);
  return { score: 1 };
}`);
  enqueueExperiment(registry, { key: 'never-started', configuration: {}, workerModule: worker });
  assert.equal(cancelExperiment(registry, 'never-started').status, 'cancelled');
  const continuous = runQueue(registry, { idleMs: 200, pollMs: 10, maxLogBytes: 1024, maxArtifactBytes: 1024, maxResultBytes: 1024, timeoutMs: 5000 });
  await delay(30);
  for (const mode of ['log', 'artifact', 'result', 'success']) enqueueExperiment(registry, { key: mode, configuration: { mode }, workerModule: worker });
  await continuous;
  const jobs = listExperiments(registry);
  assert.equal(jobs.find(job => job.key === 'log').attempts[0].error.code, 'LOG_LIMIT');
  assert.equal(jobs.find(job => job.key === 'artifact').attempts[0].error.code, 'ARTIFACT_LIMIT');
  assert.equal(jobs.find(job => job.key === 'result').attempts[0].error.code, 'RESULT_LIMIT');
  assert.equal(jobs.find(job => job.key === 'success').status, 'completed');
  enqueueExperiment(registry, { key: 'running-cancel', configuration: { mode: 'hang' }, workerModule: worker });
  const cancellable = runQueue(registry, { pollMs: 10 });
  await eventually(() => listExperiments(registry).find(job => job.key === 'running-cancel')?.status === 'running');
  cancelExperiment(registry, 'running-cancel', 'Campaign cancelled');
  await cancellable;
  assert.equal(listExperiments(registry).find(job => job.key === 'running-cancel').status, 'cancelled');
  for (const shutdown of ['drain', 'cancel']) {
    enqueueExperiment(registry, { key: `abort-${shutdown}`, configuration: { mode: shutdown === 'cancel' ? 'hang' : 'success' }, workerModule: worker });
    const controller = new AbortController();
    const running = runQueue(registry, { signal: controller.signal, shutdown, keyPrefix: `abort-${shutdown}`, pollMs: 10 });
    await eventually(() => listExperiments(registry).find(job => job.key === `abort-${shutdown}`)?.status === 'running');
    controller.abort(); await running;
    assert.equal(listExperiments(registry).find(job => job.key === `abort-${shutdown}`).status, shutdown === 'cancel' ? 'cancelled' : 'completed');
  }
  assert.equal(queueStatus(registry).supervisors.length, 0);
});

test('memory budgets refuse undeclared jobs and a shared admission directory spans registries', async t => {
  const { registry, worker, root } = fixture(t, `
import { setTimeout as delay } from 'node:timers/promises';
export default async () => { await delay(80); return { score: 1 }; }`);
  const second = join(root, 'second'), admissionRoot = join(root, 'shared-admission');
  enqueueExperiment(registry, { key: 'first', configuration: {}, workerModule: worker });
  await assert.rejects(runQueue(registry, { resourceBudget: { workers: 1, cpuThreads: 1, memoryMiB: 128 } }), { code: 'RESOURCE_BUDGET' });
  await assert.rejects(runQueue(registry, { resourceBudget: { worker: 1 } }), { code: 'INVALID_BUDGET' });
  assert.throws(() => enqueueExperiment(registry, { key: 'typo', configuration: {}, workerModule: worker, resources: { memoryMB: 128 } }), { code: 'INVALID_RESOURCES' });
  const resources = { cpuThreads: 1, memoryMiB: 128 };
  enqueueExperiment(second, { key: 'second', configuration: {}, workerModule: worker, resources });
  // Use an independent registry without the undeclared job for shared admission.
  const third = join(root, 'third');
  enqueueExperiment(third, { key: 'third', configuration: {}, workerModule: worker, resources });
  const options = { admissionRoot, resourceBudget: { workers: 1, cpuThreads: 1, memoryMiB: 128 }, concurrency: 3, pollMs: 10 };
  await Promise.all([runQueue(second, options), runQueue(third, options)]);
  assert.equal(listExperiments(second)[0].status, 'completed');
  assert.equal(listExperiments(third)[0].status, 'completed');
  assert.equal(queueStatus(second, { admissionRoot }).reserved.workers, 0);
  assert.deepEqual(recoverQueue(second, { admissionRoot }).reserved, { workers: 0, cpuThreads: 0, memoryMiB: 0 });
});


test('external admission recovery never releases live ownership and dead attempts still need explicit recovery', async t => {
  const { registry, worker, root } = fixture(t, `
import { existsSync } from 'node:fs';
export default async configuration => {
  if (!existsSync(configuration.release)) await new Promise(() => setInterval(() => {}, 1000));
  return { recovered: true };
}`);
  const release = join(root, 'release'), admissionRoot = join(root, 'external-admission');
  enqueueExperiment(registry, { key: 'interrupted', configuration: { release }, workerModule: worker });
  const runner = runProcess(`import { runQueue } from ${JSON.stringify(api)}; await runQueue(${JSON.stringify(registry)}, { admissionRoot: ${JSON.stringify(admissionRoot)}, timeoutMs: 30000 });`);
  let workerPid;
  t.after(() => { runner.child.kill(); if (workerPid) { try { process.kill(workerPid); } catch {} } });
  await eventually(() => listExperiments(registry)[0]?.status === 'running');
  workerPid = listExperiments(registry)[0].attempts[0].workerPid;
  assert.equal(recoverQueue(registry, { admissionRoot }).reserved.workers, 1, 'Live reservations are preserved');
  runner.child.kill(); await runner.done;
  try { process.kill(workerPid); } catch {}
  await eventually(() => { try { process.kill(workerPid, 0); return false; } catch { return true; } });
  assert.equal(queueStatus(registry, { admissionRoot }).reserved.workers, 1, 'Elapsed time does not release ownership');
  assert.equal(recoverQueue(registry, { admissionRoot }).reserved.workers, 0);
  assert.equal(listExperiments(registry)[0].status, 'running', 'Admission recovery does not retry experiments');
  recoverExperiment(registry, 'interrupted');
  writeFileSync(release, 'go');
  await runQueue(registry, { admissionRoot });
  assert.equal(listExperiments(registry)[0].status, 'completed');
  assert.equal(listExperiments(registry)[0].attempts.length, 2);
});


test('clean runner release during liveness probing does not become abandoned ownership', async t => {
  const { registry, worker, root } = fixture(t, `
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
export default async configuration => {
  if (configuration.release) while (!existsSync(configuration.release)) await delay(2);
  return { score: 1 };
}`);
  const release = join(root, 'release');
  enqueueExperiment(registry, { key: 'first', configuration: { release }, workerModule: worker });
  const runner = runProcess(`import { runQueue } from ${JSON.stringify(api)}; await runQueue(${JSON.stringify(registry)}, { keyPrefix: 'first', resourceBudget: { workers: 1, cpuThreads: 1 }, pollMs: 5, timeoutMs: 15000 });`);
  t.after(() => runner.child.kill());
  await eventually(() => listExperiments(registry)[0]?.status === 'running');
  enqueueExperiment(registry, { key: 'next', configuration: {}, workerModule: worker });
  const originalKill = process.kill;
  let interleaved = false;
  process.kill = function(pid, signal) {
    if (pid === runner.child.pid && signal === 0 && !interleaved) {
      interleaved = true;
      // Pause the liveness probe after runQueue has sampled reservations. The
      // independent runner completes through its normal interface and releases
      // ownership while this probe is paused. Reporting ESRCH controls the
      // exact clean-exit interleaving without depending on OS reaping timing.
      writeFileSync(release, 'go');
      const until = Date.now() + 8000;
      while (queueStatus(registry).reservations.some(record => record.supervisorPid === pid)) {
        if (Date.now() >= until) throw new Error('Clean runner did not release its reservation');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      throw Object.assign(new Error('Controlled supervisor exit probe'), { code: 'ESRCH' });
    }
    return originalKill.call(process, pid, signal);
  };
  try { await runQueue(registry, { keyPrefix: 'next', pollMs: 5 }); }
  finally { process.kill = originalKill; }
  assert.equal(interleaved, true, 'The liveness probe observes a release after its reservation snapshot');
  const result = await runner.done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(listExperiments(registry).map(job => job.status), ['completed', 'completed']);
  assert.equal(queueStatus(registry).reserved.workers, 0);
});
