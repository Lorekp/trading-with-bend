import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalExperimentJson, deterministicSeed, enqueueExperiment, listExperiments, readExperimentResult, recoverExperiment, runQueue, verifyExperimentArtifacts, writeExperimentArtifact } from '../src/experiments.mjs';

const api = new URL('../src/experiments.mjs', import.meta.url).href;
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

test('binary models and JSON metrics are bound to the result and checked for edits, additions and deletion', async t => {
  const { registry, worker } = fixture(t, `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default (configuration, context) => {
  context.writeArtifact('metrics.json', { score: 7 });
  writeFileSync(join(context.outputDirectory, 'model.bin'), Buffer.from([0, 1, 2, 255]));
  return { score: 7 };
};`);
  enqueueExperiment(registry, { key: 'model', configuration: {}, workerModule: worker });
  const [job] = await runQueue(registry);
  const directory = job.attempts[0].outputDirectory;
  assert.deepEqual(Object.keys(verifyExperimentArtifacts(registry, 'model')).sort(), ['metrics.json', 'model.bin']);
  writeFileSync(join(directory, 'model.bin'), Buffer.from([3, 4]));
  assert.throws(() => readExperimentResult(registry, 'model'), { code: 'ARTIFACT_CHANGED' });
  writeFileSync(join(directory, 'model.bin'), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(directory, 'extra.json'), '{}');
  assert.throws(() => verifyExperimentArtifacts(registry, 'model'), { code: 'ARTIFACT_CHANGED' });
  rmSync(join(directory, 'extra.json'));
  rmSync(join(directory, 'metrics.json'));
  assert.throws(() => verifyExperimentArtifacts(registry, 'model'), { code: 'ARTIFACT_CHANGED' });
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
