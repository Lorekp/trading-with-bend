import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { runtimeProvenance } from './provenance.mjs';

export class ExperimentError extends Error {
  constructor(code, message) { super(message); this.name = 'ExperimentError'; this.code = code; }
}
const assert = (condition, code, message) => { if (!condition) throw new ExperimentError(code, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function digestFile(path) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

function artifactInventory(directory, prefix = '') {
  const hashes = Object.create(null);
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    const relative = prefix + entry.name, path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), 'ARTIFACT_TYPE', 'Artifact symlinks are unsupported; store the actual artifact inside this attempt');
    if (entry.isDirectory()) Object.assign(hashes, artifactInventory(path, `${relative}/`));
    else {
      assert(entry.isFile(), 'ARTIFACT_TYPE', 'Artifacts must be regular files');
      hashes[relative] = digestFile(path);
    }
  }
  return hashes;
}

// Reject values JSON would silently discard, round-trip differently, or alias.
export function canonicalExperimentJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    assert(Number.isFinite(value) && !Object.is(value, -0), 'INVALID_JSON', 'Numbers must be finite; negative zero is unsupported');
    return JSON.stringify(value);
  }
  assert(value && typeof value === 'object' && !ancestors.has(value), 'INVALID_JSON', 'Experiments require acyclic JSON values');
  assert(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'INVALID_JSON', 'Experiments require plain JSON objects');
  assert(Reflect.ownKeys(value).every(key => typeof key === 'string'), 'INVALID_JSON', 'Symbol properties are unsupported');
  assert(Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) => Array.isArray(value) && key === 'length' || descriptor.enumerable && Object.hasOwn(descriptor, 'value')), 'INVALID_JSON', 'Getters and hidden properties are unsupported');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    assert(Object.keys(value).length === value.length, 'INVALID_JSON', 'Sparse arrays and extra array properties are unsupported');
    result = `[${Array.from(value, child => canonicalExperimentJson(child, ancestors)).join(',')}]`;
  } else {
    result = `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${canonicalExperimentJson(value[key], ancestors)}`).join(',')}}`;
  }
  ancestors.delete(value);
  return result;
}

export function deterministicSeed(key) {
  assert(typeof key === 'string' && key.length > 0, 'INVALID_KEY', 'An experiment key is required');
  return Number.parseInt(digest(`experiment-seed-v1\0${key}`).slice(0, 8), 16);
}

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const optionalRead = path => { try { return read(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const directory = (root, key) => join(resolve(root), 'jobs', digest(key));
const attemptDirectory = (jobDirectory, token) => join(jobDirectory, 'attempts', token);

function validateManifest(manifest) {
  const { specificationHash, createdAt, ...specification } = manifest;
  assert(manifest.version === 1 && digest(canonicalExperimentJson(specification)) === specificationHash && digest(canonicalExperimentJson(manifest.configuration)) === manifest.configurationHash, 'REGISTRY_CORRUPT', 'Experiment manifest does not match its immutable specification/configuration hashes');
  return manifest;
}

function toolkitProvenance() {
  const sources = runtimeProvenance();
  const currentModules = readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.mjs')).map(name => `src/${name}`).sort(compare);
  assert(canonicalExperimentJson(currentModules) === canonicalExperimentJson(Object.keys(sources).filter(path => path.startsWith('src/')).sort(compare)), 'STALE_RUNTIME', 'Toolkit module set changed after this process loaded; restart the process');
  assert(Object.entries(sources).every(([path, hash]) => digest(readFileSync(new URL(`../${path}`, import.meta.url))) === hash), 'STALE_RUNTIME', 'Toolkit changed after this process loaded; restart before queueing or executing experiments');
  const verification = read(fileURLToPath(new URL('../build/verification.json', import.meta.url)));
  assert(verification.compiler === 'passed' && verification.sourceHashes && Object.keys(verification.sourceHashes).length > 0 && Object.entries(verification.sourceHashes).every(([path, hash]) => sources[path] === hash), 'STALE_BUILD', 'Build evidence differs from current sources; run npm run build');
  return { sources, verification, node: process.version, platform: process.platform, architecture: process.arch };
}

// Publish a fully written, fsynced file with an exclusive hard link. Readers
// never see partial JSON, and no publisher can replace another publisher's file.
// The registry must live on one local filesystem supporting atomic hard links.
function publish(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.publish-${randomUUID()}.tmp`);
  const bytes = canonicalExperimentJson(value) + '\n';
  let fd;
  try {
    fd = openSync(temporary, 'wx');
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temporary, path); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function moduleUrl(module) {
  const url = module instanceof URL ? module : typeof module === 'string' && module.startsWith('file:') ? new URL(module) : pathToFileURL(resolve(String(module)));
  assert(url.protocol === 'file:' && !url.search && !url.hash, 'WORKER_MODULE', 'workerModule must be a local file path or file URL without query/fragment');
  assert(existsSync(fileURLToPath(url)), 'WORKER_MODULE', 'workerModule does not exist');
  return url.href;
}

/** Idempotently enqueue a key. Changed configuration, seed, entrypoint path,
 * or entrypoint bytes under the same key are rejected, including across agents. */
export function enqueueExperiment(root, { key, configuration, workerModule, dependencies = [], seed = deterministicSeed(key) }) {
  assert(typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.includes('\0'), 'INVALID_KEY', 'key must contain 1..1024 characters without null bytes');
  assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'INVALID_SEED', 'seed must be an unsigned 32-bit integer');
  const configurationJson = canonicalExperimentJson(configuration);
  const worker = moduleUrl(workerModule);
  assert(Array.isArray(dependencies), 'DEPENDENCIES', 'dependencies must be an array of local file paths or file URLs');
  const dependencyHashes = Object.fromEntries([...new Set(dependencies.map(moduleUrl))].sort(compare).map(url => [url, digestFile(fileURLToPath(url))]));
  const specification = { version: 1, key, configuration: JSON.parse(configurationJson), configurationHash: digest(configurationJson), workerModule: worker, workerHash: digestFile(fileURLToPath(worker)), dependencies: dependencyHashes, toolkit: toolkitProvenance(), seed };
  const specificationHash = digest(canonicalExperimentJson(specification));
  const manifest = { ...specification, specificationHash, createdAt: new Date().toISOString() };
  const path = join(directory(root, key), 'manifest.json');
  if (publish(path, manifest)) return manifest;
  const existing = validateManifest(read(path));
  assert(existing.specificationHash === specificationHash, 'EXPERIMENT_COLLISION', `Experiment key ${JSON.stringify(key)} already has a different immutable specification`);
  return existing;
}

function inspectJob(jobDirectory) {
  const manifest = optionalRead(join(jobDirectory, 'manifest.json'));
  if (!manifest) return null; // Interrupted enqueue before atomic publication.
  validateManifest(manifest);
  assert(digest(manifest.key) === basename(jobDirectory), 'REGISTRY_CORRUPT', 'Manifest key does not match its job directory');
  const attempts = [];
  for (let generation = 0; ; generation++) {
    const claim = optionalRead(join(jobDirectory, 'claims', `${generation}.json`));
    if (!claim) return { ...manifest, status: 'queued', generation, attempts };
    assert(claim.generation === generation && typeof claim.token === 'string' && /^[0-9a-f-]{36}$/.test(claim.token), 'REGISTRY_CORRUPT', 'Invalid attempt ownership record');
    const path = attemptDirectory(jobDirectory, claim.token);
    const finish = optionalRead(join(path, 'finished.json'));
    const recovery = optionalRead(join(path, 'recovery.json'));
    assert(!finish || finish.token === claim.token && ['completed', 'failed', 'abandoned'].includes(finish.status), 'REGISTRY_CORRUPT', 'Terminal attempt does not match its ownership record');
    assert(finish?.status !== 'completed' || /^[0-9a-f]{64}$/.test(finish.resultHash) && finish.artifactHashes && typeof finish.artifactHashes === 'object' && !Array.isArray(finish.artifactHashes), 'REGISTRY_CORRUPT', 'Completed attempt has invalid result/artifact hashes');
    attempts.push({ ...claim, ...finish, status: finish?.status ?? 'running', outputDirectory: join(path, 'artifacts'), ...(recovery ? { recovery } : {}) });
    if (!recovery) return { ...manifest, status: finish?.status ?? 'running', generation, attempts };
    assert(recovery.token === claim.token && recovery.nextGeneration === generation + 1, 'REGISTRY_CORRUPT', 'Invalid recovery chain');
  }
}

/** Deterministic key order; running, failed, abandoned, and completed jobs stay
 * in the returned population. Previous attempts are never discarded. */
export function listExperiments(root) {
  const jobs = join(resolve(root), 'jobs');
  let entries;
  try { entries = readdirSync(jobs, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name)).map(entry => inspectJob(join(jobs, entry.name))).filter(Boolean).sort((a, b) => compare(a.key, b.key));
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** Explicitly recover only unfinished claims whose worker AND supervisor are
 * dead on this host. PID reuse conservatively prevents recovery. No lease or
 * elapsed-time rule can steal an active attempt. */
export function recoverExperiment(root, key) {
  const jobDirectory = directory(root, key);
  const job = inspectJob(jobDirectory);
  assert(job, 'UNKNOWN_EXPERIMENT', `Unknown experiment ${JSON.stringify(key)}`);
  // The abandoned marker can survive an interruption before recovery.json was
  // published. An explicit second recovery must be able to finish that step.
  assert(job.status === 'running' || job.status === 'abandoned', 'NOT_ABANDONED', 'Only unfinished, abandoned attempts can be recovered');
  const claim = job.attempts.at(-1);
  assert(claim.hostname === hostname(), 'REMOTE_OWNER', 'Recovery is only supported on the original host');
  assert(!alive(claim.workerPid) && !alive(claim.supervisorPid), 'OWNER_ALIVE', 'Worker or supervisor is still alive; recovery is refused');
  const path = attemptDirectory(jobDirectory, claim.token);
  publish(join(path, 'finished.json'), { token: claim.token, status: 'abandoned', finishedAt: new Date().toISOString(), error: { code: 'ABANDONED', message: 'Explicit recovery after worker and supervisor exited' } });
  publish(join(path, 'recovery.json'), { token: claim.token, nextGeneration: job.generation + 1, recoveredAt: new Date().toISOString(), recoveredByPid: process.pid });
  return inspectJob(jobDirectory);
}

// Internal worker protocol: claim from within the child so the immutable claim
// always names the process that will execute strategy code.
export function claimExperiment(root, key, token, supervisorPid, generation) {
  const jobDirectory = directory(root, key);
  const job = inspectJob(jobDirectory);
  if (!job || job.status !== 'queued' || job.generation !== generation) return null;
  const claim = { token, generation, workerPid: process.pid, supervisorPid, hostname: hostname(), startedAt: new Date().toISOString() };
  mkdirSync(join(attemptDirectory(jobDirectory, token), 'artifacts'), { recursive: true });
  if (!publish(join(jobDirectory, 'claims', `${generation}.json`), claim)) return null;
  return { manifest: job, claim, path: attemptDirectory(jobDirectory, token) };
}

export function finishExperimentAttempt(path, token, result, error) {
  const finishedAt = new Date().toISOString();
  if (arguments.length >= 4) {
    publish(join(path, 'finished.json'), { token, status: 'failed', finishedAt, error: { code: String(error?.code || 'WORKER_ERROR'), message: String(error?.message ?? error) } });
  } else {
    const resultJson = canonicalExperimentJson(result);
    const artifactHashes = artifactInventory(join(path, 'artifacts'));
    publish(join(path, 'result.json'), result);
    publish(join(path, 'finished.json'), { token, status: 'completed', finishedAt, resultHash: digest(resultJson), resultPath: join(path, 'result.json'), artifactHashes });
  }
}

export function verifyWorker(manifest) {
  assert(digestFile(fileURLToPath(manifest.workerModule)) === manifest.workerHash, 'WORKER_CHANGED', 'Worker entrypoint changed after enqueue; create a new experiment key');
  assert(Object.entries(manifest.dependencies).every(([url, hash]) => digestFile(fileURLToPath(url)) === hash), 'DEPENDENCY_CHANGED', 'A declared worker dependency or dataset changed after enqueue');
  assert(canonicalExperimentJson(toolkitProvenance()) === canonicalExperimentJson(manifest.toolkit), 'TOOLKIT_CHANGED', 'Toolkit or runtime changed after enqueue; use the original checkout or a new experiment key');
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => child.kill());
    killer.once('exit', code => { if (code !== 0) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

async function execute(root, job, timeoutMs) {
  const token = randomUUID(), jobDirectory = directory(root, job.key), path = attemptDirectory(jobDirectory, token);
  mkdirSync(path, { recursive: true });
  const stdout = createWriteStream(join(path, 'stdout.log'), { flags: 'wx' });
  const stderr = createWriteStream(join(path, 'stderr.log'), { flags: 'wx' });
  const deadline = Date.now() + timeoutMs;
  const child = fork(new URL('./experiment-worker.mjs', import.meta.url), [resolve(root), job.key, token, String(process.pid), String(job.generation), String(deadline)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [], windowsHide: true, detached: process.platform !== 'win32',
  });
  let timedOut = false, spawnError, logError;
  const logs = [pipeline(child.stdout, stdout), pipeline(child.stderr, stderr)].map(promise => promise.catch(error => { logError = error; if (!timedOut) terminate(child); }));
  const timer = setTimeout(() => {
    timedOut = true; terminate(child);
    // A strategy-spawned descendant may inherit these pipes after the worker
    // exits. Do not let inherited handles keep the queue waiting indefinitely.
    child.stdout.destroy(); child.stderr.destroy();
  }, timeoutMs);
  const { code, signal } = await new Promise(resolveExit => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timer);
  await Promise.all(logs);
  const claimPath = join(jobDirectory, 'claims', `${job.generation}.json`);
  let claim = optionalRead(claimPath);
  if (!claim) {
    // Even a timeout during startup is a recorded failure. Exclusive publication
    // still lets another contender win without overwriting its ownership.
    publish(claimPath, { token, generation: job.generation, workerPid: child.pid ?? 0, supervisorPid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() });
    claim = read(claimPath);
  }
  if (claim?.token === token && !existsSync(join(path, 'finished.json'))) {
    finishExperimentAttempt(path, token, null, { code: timedOut ? 'WORKER_TIMEOUT' : logError ? 'WORKER_LOG_IO' : 'WORKER_CRASH', message: timedOut ? `Worker exceeded ${timeoutMs} ms` : String(spawnError?.message ?? logError?.message ?? `Worker exited without a result (code ${code}, signal ${signal})`) });
  }
}

/** Drain the currently queued snapshot with bounded child-process concurrency.
 * Multiple independent invocations can safely share the same local registry.
 * concurrency is per invocation, not a machine-wide limit. */
export async function runQueue(root, { concurrency = 1, timeoutMs = 60_000 } = {}) {
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 256, 'INVALID_CONCURRENCY', 'concurrency must be an integer in 1..256');
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647, 'INVALID_TIMEOUT', 'timeoutMs must be a positive 32-bit timer interval');
  const pending = listExperiments(root).filter(job => job.status === 'queued');
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (cursor < pending.length) await execute(root, pending[cursor++], timeoutMs);
  }));
  return listExperiments(root);
}

/** Read and verify a completed result instead of trusting a mutable artifact. */
export function readExperimentResult(root, key) {
  const job = inspectJob(directory(root, key));
  assert(job?.status === 'completed', 'RESULT_UNAVAILABLE', 'Experiment has no completed result');
  const attempt = job.attempts.at(-1);
  const result = read(join(attemptDirectory(directory(root, key), attempt.token), 'result.json'));
  assert(digest(canonicalExperimentJson(result)) === attempt.resultHash, 'RESULT_CHANGED', 'Result artifact no longer matches its recorded hash');
  verifyExperimentArtifacts(root, key);
  return result;
}

/** Verify every supplementary file, including binary models written directly
 * inside outputDirectory. Added, removed, and changed files invalidate it. */
export function verifyExperimentArtifacts(root, key) {
  const job = inspectJob(directory(root, key));
  assert(job?.status === 'completed', 'RESULT_UNAVAILABLE', 'Experiment has no completed artifacts');
  const attempt = job.attempts.at(-1);
  let actual;
  try { actual = artifactInventory(join(attemptDirectory(directory(root, key), attempt.token), 'artifacts')); }
  catch (error) { throw new ExperimentError('ARTIFACT_CHANGED', `Artifact inventory cannot be verified: ${error.message}`); }
  assert(canonicalExperimentJson(actual) === canonicalExperimentJson(attempt.artifactHashes), 'ARTIFACT_CHANGED', 'Supplementary artifacts no longer match the recorded inventory');
  return actual;
}

export function writeExperimentArtifact(outputDirectory, relativePath, value) {
  assert(typeof relativePath === 'string' && relativePath.length > 0 && !isAbsolute(relativePath), 'ARTIFACT_PATH', 'Artifact path must be relative');
  const target = resolve(outputDirectory, relativePath), base = resolve(outputDirectory);
  assert(target.startsWith(base + (process.platform === 'win32' ? '\\' : '/')), 'ARTIFACT_PATH', 'Artifact path must remain inside this attempt');
  assert(publish(target, value), 'ARTIFACT_EXISTS', 'Artifact already exists; attempt artifacts cannot be overwritten');
  return target;
}
