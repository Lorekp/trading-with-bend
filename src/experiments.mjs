import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { hostname } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { verifiedRuntimeProvenance } from './provenance.mjs';
import { createWorkerBundle, verifyWorkerBundle, workerBundleExecution } from './worker-bundle.mjs';
import { publishImmutable } from './immutable-files.mjs';

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
const directory = (root, key) => join(registryJobs(root), digest(key));
const attemptDirectory = (jobDirectory, token) => join(jobDirectory, 'attempts', token);

function registryJobs(root) {
  const path = resolve(root);
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return join(path, 'jobs'); throw error; }
  assert(!entries.some(entry => entry.isFile() && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.json$/.test(entry.name)),
    'REGISTRY_VERSION', 'Legacy inline records require their original toolkit; use a new registry instead of mixing formats');
  return join(path, 'jobs');
}

function validateManifest(manifest) {
  const { specificationHash, createdAt, ...specification } = manifest;
  assert(manifest.version === 2, 'REGISTRY_VERSION', 'Use the original toolkit to inspect this registry version, or start a new registry');
  assert(['inline', 'worker'].includes(manifest.execution) && digest(canonicalExperimentJson(specification)) === specificationHash && digest(canonicalExperimentJson(manifest.configuration)) === manifest.configurationHash, 'REGISTRY_CORRUPT', 'Experiment manifest does not match its immutable specification/configuration hashes');
  return manifest;
}

function toolkitProvenance() {
  const { sources, verification } = verifiedRuntimeProvenance();
  return { sources, verification, node: process.version, platform: process.platform, architecture: process.arch };
}

// Publish a fully written, fsynced file with an exclusive hard link. Readers
// never see partial JSON, and no publisher can replace another publisher's file.
// The registry must live on one local filesystem supporting atomic hard links.
function publish(path, value) {
  return publishImmutable(path, canonicalExperimentJson(value) + '\n');
}

function moduleUrl(module) {
  const url = module instanceof URL ? module : typeof module === 'string' && module.startsWith('file:') ? new URL(module) : pathToFileURL(resolve(String(module)));
  assert(url.protocol === 'file:' && !url.search && !url.hash, 'WORKER_MODULE', 'workerModule must be a local file path or file URL without query/fragment');
  assert(existsSync(fileURLToPath(url)), 'WORKER_MODULE', 'workerModule does not exist');
  return url.href;
}

/** Idempotently enqueue a key. Changed configuration, seed, entrypoint path,
 * or entrypoint bytes under the same key are rejected, including across agents. */
export function enqueueExperiment(root, { key, configuration, workerModule, dependencies = [], seed = deterministicSeed(key), resources = {}, frozen = false, inputFiles = {}, constrained = true, sourceRoot, bundle } = {}) {
  assert(typeof frozen === 'boolean' && typeof constrained === 'boolean', 'WORKER_ISOLATION', 'frozen and constrained must be booleans');
  assert(typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.includes('\0'), 'INVALID_KEY', 'key must contain 1..1024 characters without null bytes');
  assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'INVALID_SEED', 'seed must be an unsigned 32-bit integer');
  canonicalExperimentJson(configuration);
  assert(Array.isArray(dependencies), 'DEPENDENCIES', 'dependencies must be an array of local file paths or file URLs');
  assert(resources && typeof resources === 'object' && !Array.isArray(resources) && Object.keys(resources).every(key => ['cpuThreads', 'memoryMiB'].includes(key)), 'INVALID_RESOURCES', 'resources only accepts cpuThreads and memoryMiB');
  const { cpuThreads = 1, memoryMiB = 0 } = resources;
  assert(Number.isInteger(cpuThreads) && cpuThreads > 0 && Number.isInteger(memoryMiB) && memoryMiB >= 0, 'INVALID_RESOURCES', 'resources require positive cpuThreads and nonnegative memoryMiB integers');
  if (frozen) {
    if (bundle) verifyWorkerBundle(bundle);
    else {
      const snapshot = createWorkerBundle(root, { workerModule, dependencies, configuration, inputFiles, ...(sourceRoot === undefined ? {} : { sourceRoot }) });
      bundle = snapshot.bundle;
      configuration = snapshot.configuration;
    }
    workerModule = bundle.workerModule;
  } else {
    assert(inputFiles && Object.keys(inputFiles).length === 0 && sourceRoot === undefined && bundle === undefined, 'WORKER_ISOLATION', 'inputFiles, sourceRoot and bundles require frozen execution');
  }
  const worker = moduleUrl(workerModule);
  const dependencyHashes = bundle?.dependencies ?? Object.fromEntries([...new Set(dependencies.map(moduleUrl))].sort(compare).map(url => [url, digestFile(fileURLToPath(url))]));
  return registerExperiment(root, { key, configuration, seed, resources: { cpuThreads, memoryMiB }, execution: 'worker', workerModule: worker, workerHash: digestFile(fileURLToPath(worker)), dependencies: dependencyHashes, ...(bundle ? { bundle, constrained } : {}) });
}

function registerExperiment(root, { key, configuration, seed, ...execution }) {
  assert(typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.includes('\0'), 'INVALID_KEY', 'key must contain 1..1024 characters without null bytes');
  assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'INVALID_SEED', 'seed must be an unsigned 32-bit integer');
  const configurationJson = canonicalExperimentJson(configuration);
  const specification = { version: 2, key, configuration: JSON.parse(configurationJson), configurationHash: digest(configurationJson), ...execution, toolkit: execution.bundle?.provenance ?? toolkitProvenance(), seed };
  const specificationHash = digest(canonicalExperimentJson(specification));
  const manifest = { ...specification, specificationHash, createdAt: new Date().toISOString() };
  const path = join(directory(root, key), 'manifest.json');
  if (publish(path, manifest)) return manifest;
  const existing = validateManifest(read(path));
  assert(existing.specificationHash === specificationHash, 'EXPERIMENT_COLLISION', `Experiment key ${JSON.stringify(key)} already has a different immutable specification`);
  return existing;
}

/** Execute synchronous work with the same durable attempt and context as workers.
 * The callback receives (configuration, context); its closure is not resumable. */
export function runExperiment(root, configuration, work) {
  assert(typeof work === 'function', 'EXPERIMENT_CALLBACK', 'Expected a synchronous experiment callback');
  const id = randomUUID(), token = randomUUID();
  // Publish ownership first so a visible inline manifest can never be ownerless.
  // An interruption before the manifest leaves an ignored unpublished directory.
  const owned = claimAttempt(directory(root, id), token, process.pid, 0);
  assert(owned, 'EXPERIMENT_COLLISION', 'Inline experiment identity is already claimed');
  const manifest = registerExperiment(root, { key: id, configuration, seed: deterministicSeed(id), execution: 'inline' });
  const context = experimentContext({ ...owned, manifest });
  try {
    const result = work(structuredClone(manifest.configuration), context);
    if (result && typeof result.then === 'function') {
      // Consume async rejection after recording the synchronous interface error.
      Promise.resolve(result).catch(() => {});
      throw new ExperimentError('ASYNC_EXPERIMENT', 'Use a queued worker for asynchronous work');
    }
    verifyExperiment(manifest);
    finishExperimentAttempt(owned.path, token, result);
    return { id, result };
  } catch (error) {
    finishExperimentAttempt(owned.path, token, null, error);
    throw error;
  }
}

function inspectJob(jobDirectory) {
  const manifest = optionalRead(join(jobDirectory, 'manifest.json'));
  if (!manifest) return null; // Interrupted enqueue before atomic publication.
  validateManifest(manifest);
  assert(digest(manifest.key) === basename(jobDirectory), 'REGISTRY_CORRUPT', 'Manifest key does not match its job directory');
  const attempts = [];
  for (let generation = 0; ; generation++) {
    const claim = optionalRead(join(jobDirectory, 'claims', `${generation}.json`));
    if (!claim) return { ...manifest, status: optionalRead(join(jobDirectory, 'cancelled.json')) ? 'cancelled' : 'queued', generation, attempts };
    assert(claim.generation === generation && typeof claim.token === 'string' && /^[0-9a-f-]{36}$/.test(claim.token), 'REGISTRY_CORRUPT', 'Invalid attempt ownership record');
    const path = attemptDirectory(jobDirectory, claim.token);
    const finish = optionalRead(join(path, 'finished.json'));
    const recovery = optionalRead(join(path, 'recovery.json'));
    assert(!finish || finish.token === claim.token && ['completed', 'failed', 'abandoned', 'cancelled'].includes(finish.status), 'REGISTRY_CORRUPT', 'Terminal attempt does not match its ownership record');
    assert(finish?.status !== 'completed' || /^[0-9a-f]{64}$/.test(finish.resultHash) && finish.artifactHashes && typeof finish.artifactHashes === 'object' && !Array.isArray(finish.artifactHashes), 'REGISTRY_CORRUPT', 'Completed attempt has invalid result/artifact hashes');
    const telemetry = optionalRead(join(path, 'telemetry.json'));
    attempts.push({ ...claim, ...finish, status: finish?.status ?? 'running', outputDirectory: join(path, 'artifacts'), ...(telemetry ? { telemetry } : {}), ...(recovery ? { recovery } : {}) });
    if (!recovery) return { ...manifest, status: finish?.status ?? 'running', generation, attempts };
    assert(recovery.token === claim.token && recovery.nextGeneration === generation + 1, 'REGISTRY_CORRUPT', 'Invalid recovery chain');
  }
}

/** Deterministic key order; running, failed, abandoned, and completed jobs stay
 * in the returned population. Previous attempts are never discarded. */
export function listExperiments(root) {
  const jobs = registryJobs(root);
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
  // A persisted worker entrypoint can be retried. An inline closure cannot:
  // recovery terminates its abandoned attempt; register a fresh trial to rerun.
  if (job.execution === 'worker') publish(join(path, 'recovery.json'), { token: claim.token, nextGeneration: job.generation + 1, recoveredAt: new Date().toISOString(), recoveredByPid: process.pid });
  // The existing explicit job recovery also releases its default admission
  // reservation after the same worker/supervisor death checks. Shared external
  // admission directories are recovered through recoverQueue.
  const admission = admissionDirectory(root);
  for (const reservation of reservations(admission)) {
    if (reservation.registry === resolve(root) && reservation.attemptToken === claim.token) releaseReservation(admission, reservation.token, 'explicit-job-recovery');
  }
  return inspectJob(jobDirectory);
}

// Internal worker protocol: claim from within the child so the immutable claim
// always names the process that will execute strategy code.
export function claimExperiment(root, key, token, supervisorPid, generation) {
  // The supervisor has validated the registry. A restricted worker only needs
  // its own job directory, never a directory listing of other agents' jobs.
  const jobDirectory = join(resolve(root), 'jobs', digest(key));
  const job = inspectJob(jobDirectory);
  if (!job || job.execution !== 'worker' || job.status !== 'queued' || job.generation !== generation) return null;
  const owned = claimAttempt(jobDirectory, token, supervisorPid, generation);
  return owned && { manifest: job, ...owned };
}

function claimAttempt(jobDirectory, token, supervisorPid, generation) {
  const claim = { token, generation, workerPid: process.pid, supervisorPid, hostname: hostname(), startedAt: new Date().toISOString() };
  mkdirSync(join(attemptDirectory(jobDirectory, token), 'artifacts'), { recursive: true });
  if (!publish(join(jobDirectory, 'claims', `${generation}.json`), claim)) return null;
  return { claim, path: attemptDirectory(jobDirectory, token) };
}

export function experimentContext({ manifest, claim, path, maxArtifactBytes = null }) {
  const outputDirectory = join(path, 'artifacts');
  let latestProgress;
  const heartbeat = progress => {
    assert(!existsSync(join(path, 'finished.json')), 'ATTEMPT_FINISHED', 'Cannot report after an attempt finishes');
    const nextProgress = progress === undefined ? latestProgress : progress;
    const report = { at: new Date().toISOString(), pid: process.pid, rssBytes: process.memoryUsage().rss, ...(nextProgress === undefined ? {} : { progress: nextProgress }) };
    const bytes = canonicalExperimentJson(report);
    assert(Buffer.byteLength(bytes) <= 65536, 'PROGRESS_LIMIT', 'Progress reports must fit in 64 KiB');
    latestProgress = nextProgress;
    const temporary = join(path, `.telemetry-${randomUUID()}.tmp`);
    try { writeFileSync(temporary, bytes, { flag: 'wx' }); renameSync(temporary, join(path, 'telemetry.json')); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return report;
  };
  return Object.freeze({
    key: manifest.key, seed: manifest.seed, attemptId: claim.token, outputDirectory,
    previousAttempts: Object.freeze((manifest.attempts ?? []).filter(attempt => attempt.token !== claim.token).map(attempt => Object.freeze({ attemptId: attempt.token, status: attempt.status, outputDirectory: attempt.outputDirectory }))),
    heartbeat: () => heartbeat(), reportProgress: heartbeat,
    writeArtifact: (relativePath, value) => {
      assert(!existsSync(join(path, 'finished.json')), 'ATTEMPT_FINISHED', 'Cannot write artifacts after an attempt finishes');
      const artifact = writeExperimentArtifact(outputDirectory, relativePath, value);
      assertArtifactBudget(outputDirectory, maxArtifactBytes);
      return artifact;
    },
  });
}

export function finishExperimentAttempt(path, token, result, error) {
  const finishedAt = new Date().toISOString();
  if (arguments.length >= 4) {
    publish(join(path, 'finished.json'), { token, status: error?.code === 'WORKER_CANCELLED' ? 'cancelled' : 'failed', finishedAt, error: { code: String(error?.code || 'WORKER_ERROR'), message: String(error?.message ?? error) } });
  } else {
    const resultJson = canonicalExperimentJson(result);
    const artifactHashes = artifactInventory(join(path, 'artifacts'));
    publish(join(path, 'result.json'), result);
    publish(join(path, 'finished.json'), { token, status: 'completed', finishedAt, resultHash: digest(resultJson), resultPath: join(path, 'result.json'), artifactHashes });
  }
}

export function verifyExperiment(manifest) {
  if (manifest.bundle) {
    verifyWorkerBundle(manifest.bundle);
    assert(canonicalExperimentJson(manifest.bundle.provenance) === canonicalExperimentJson(manifest.toolkit), 'TOOLKIT_CHANGED', 'Frozen worker toolkit does not match its registered identity');
  }
  if (manifest.execution === 'worker') {
    assert(digestFile(fileURLToPath(manifest.workerModule)) === manifest.workerHash, 'WORKER_CHANGED', 'Worker entrypoint changed after enqueue; create a new experiment key');
    assert(Object.entries(manifest.dependencies).every(([url, hash]) => digestFile(fileURLToPath(url)) === hash), 'DEPENDENCY_CHANGED', 'A declared worker dependency or dataset changed after enqueue');
  }
  if (!manifest.bundle) assert(canonicalExperimentJson(toolkitProvenance()) === canonicalExperimentJson(manifest.toolkit), 'TOOLKIT_CHANGED', 'Toolkit or runtime changed after enqueue; use the original checkout or a new experiment key');
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

function artifactBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), 'ARTIFACT_TYPE', 'Artifact symlinks are unsupported');
    const file = join(path, entry.name);
    total += entry.isDirectory() ? artifactBytes(file) : statSync(file).size;
  }
  return total;
}
function assertArtifactBudget(path, limit) {
  if (limit !== null) assert(artifactBytes(path) <= limit, 'ARTIFACT_LIMIT', `Attempt artifacts exceeded ${limit} bytes`);
}

const admissionDirectory = (root, admissionRoot) => resolve(admissionRoot ?? join(root, 'admission'));
const defaultBudget = { workers: 256, cpuThreads: 256, memoryMiB: null };
function queueBudget(path, requested) {
  assert(requested === undefined || requested && typeof requested === 'object' && !Array.isArray(requested) && Object.keys(requested).every(key => ['workers', 'cpuThreads', 'memoryMiB'].includes(key)), 'INVALID_BUDGET', 'resourceBudget only accepts workers, cpuThreads, and memoryMiB');
  const existing = optionalRead(join(path, 'budget.json'));
  const budget = requested ? { ...defaultBudget, ...requested } : existing ?? defaultBudget;
  assert(Number.isInteger(budget.workers) && budget.workers > 0 && budget.workers <= 256 && Number.isInteger(budget.cpuThreads) && budget.cpuThreads > 0 && (budget.memoryMiB === null || Number.isInteger(budget.memoryMiB) && budget.memoryMiB > 0), 'INVALID_BUDGET', 'resourceBudget requires workers in 1..256, positive cpuThreads, and optional positive memoryMiB');
  publish(join(path, 'budget.json'), budget);
  const recorded = read(join(path, 'budget.json'));
  assert(canonicalExperimentJson(budget) === canonicalExperimentJson(recorded), 'BUDGET_COLLISION', 'All runners sharing an admissionRoot must use the same immutable resourceBudget');
  return recorded;
}
function records(path, name) {
  const folder = join(path, name);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(file => /^[0-9a-f-]{36}\.json$/.test(file)).map(file => read(join(folder, file)));
}
function admissionLock(path) {
  const folder = join(path, 'locks');
  const generations = existsSync(folder) ? readdirSync(folder).filter(file => /^\d+\.json$/.test(file)).map(file => Number(file.slice(0, -5))) : [];
  const generation = generations.reduce((latest, current) => Math.max(latest, current), -1);
  const claim = generation >= 0 ? read(join(folder, `${generation}.json`)) : null;
  return { generation, claim, released: claim && existsSync(join(path, 'lock-released', `${claim.token}.json`)) };
}
function locked(path, operation) {
  const { generation, claim, released } = admissionLock(path), token = randomUUID();
  if (claim && !released) {
    if (claim.hostname !== hostname() || alive(claim.supervisorPid)) return null;
    // A clean owner can publish release and exit after admissionLock sampled
    // its marker. Once death is observed, recheck the durable release before
    // classifying the claim as abandoned. Exclusive generation publication
    // still resolves any contender that advanced in the meantime.
    assert(existsSync(join(path, 'lock-released', `${claim.token}.json`)), 'ADMISSION_ABANDONED', 'Admission lock owner exited; use recoverQueue explicitly');
  }
  if (!publish(join(path, 'locks', `${generation + 1}.json`), { token, supervisorPid: process.pid, hostname: hostname() })) return null;
  try { return operation(); }
  finally { publish(join(path, 'lock-released', `${token}.json`), { token, releasedAt: new Date().toISOString() }); }
}
function reservations(path) {
  return records(path, 'reservations').filter(record => !existsSync(join(path, 'released', `${record.token}.json`)));
}
function releaseReservation(path, token, reason) {
  publish(join(path, 'released', `${token}.json`), { token, reason, releasedAt: new Date().toISOString() });
}

/** Durable cancellation is retained even when the job has never started. */
export function cancelExperiment(root, key, reason = 'Cancelled by operator') {
  const job = inspectJob(directory(root, key));
  assert(job, 'UNKNOWN_EXPERIMENT', `Unknown experiment ${JSON.stringify(key)}`);
  if (['queued', 'running'].includes(job.status)) publish(join(directory(root, key), 'cancelled.json'), { key, reason: String(reason), requestedAt: new Date().toISOString(), requestedByPid: process.pid });
  return inspectJob(directory(root, key));
}

/** Operator view of shared admission ownership and reserved resource estimates. */
export function queueStatus(root, { admissionRoot } = {}) {
  const path = admissionDirectory(root, admissionRoot), active = reservations(path);
  return { admissionRoot: path, resourceBudget: optionalRead(join(path, 'budget.json')), reservations: active, supervisors: records(path, 'supervisors').filter(record => !existsSync(join(path, 'supervisor-finished', `${record.token}.json`))), reserved: active.reduce((sum, record) => ({ workers: sum.workers + 1, cpuThreads: sum.cpuThreads + record.resources.cpuThreads, memoryMiB: sum.memoryMiB + record.resources.memoryMiB }), { workers: 0, cpuThreads: 0, memoryMiB: 0 }) };
}

/** No elapsed-time leases: only explicit recovery after both processes exited. */
export function recoverQueue(root, { admissionRoot } = {}) {
  const path = admissionDirectory(root, admissionRoot);
  const { claim: owner, released } = admissionLock(path);
  if (owner && !released) {
    assert(owner.hostname === hostname(), 'REMOTE_OWNER', 'Admission recovery requires the original host');
    assert(!alive(owner.supervisorPid), 'OWNER_ALIVE', 'Admission lock supervisor is still alive');
    publish(join(path, 'lock-released', `${owner.token}.json`), { token: owner.token, recoveredAt: new Date().toISOString() });
  }
  const result = locked(path, () => {
    for (const record of reservations(path)) {
      assert(record.hostname === hostname(), 'REMOTE_OWNER', 'Reservation recovery requires the original host');
      const worker = optionalRead(join(path, 'workers', `${record.token}.json`));
      const job = inspectJob(directory(record.registry, record.key));
      const claim = job?.attempts.find(attempt => attempt.token === record.attemptToken);
      if (alive(record.supervisorPid) || worker && alive(worker.workerPid) || claim && alive(claim.workerPid)) continue;
      releaseReservation(path, record.token, 'explicit-dead-owner-recovery');
    }
    for (const record of records(path, 'supervisors')) {
      if (record.hostname === hostname() && !alive(record.supervisorPid)) publish(join(path, 'supervisor-finished', `${record.token}.json`), { token: record.token, status: 'recovered', finishedAt: new Date().toISOString() });
    }
    return queueStatus(root, { admissionRoot });
  });
  assert(result, 'ADMISSION_BUSY', 'Admission lock is currently held; retry recovery');
  return result;
}

async function execute(root, job, options, reservation, admission) {
  const { timeoutMs, pollMs, signal, shutdown, maxLogBytes, maxArtifactBytes, maxResultBytes } = options;
  const token = reservation.attemptToken, jobDirectory = directory(root, job.key), path = attemptDirectory(jobDirectory, token);
  mkdirSync(path, { recursive: true });
  mkdirSync(join(path, 'artifacts'), { recursive: true });
  mkdirSync(join(jobDirectory, 'claims'), { recursive: true });
  let execution;
  try {
    execution = job.bundle ? workerBundleExecution(job.bundle, { jobPath: jobDirectory, attemptPath: path, constrained: job.constrained }) : { workerScript: new URL('./experiment-worker.mjs', import.meta.url), execArgv: [] };
  } catch (error) {
    if (publish(join(jobDirectory, 'claims', `${job.generation}.json`), { token, generation: job.generation, workerPid: 0, supervisorPid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() })) finishExperimentAttempt(path, token, null, error);
    return;
  }
  const stdout = createWriteStream(join(path, 'stdout.log'), { flags: 'wx' });
  const stderr = createWriteStream(join(path, 'stderr.log'), { flags: 'wx' });
  const deadline = Date.now() + timeoutMs, threads = String(reservation.resources.cpuThreads);
  const execArgv = [...execution.execArgv, ...(reservation.resources.memoryMiB > 0 ? [`--max-old-space-size=${reservation.resources.memoryMiB}`] : [])];
  const workerEnv = { ...process.env, OMP_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads, MKL_NUM_THREADS: threads, NUMEXPR_NUM_THREADS: threads, VECLIB_MAXIMUM_THREADS: threads, UV_THREADPOOL_SIZE: threads };
  if (job.bundle) { delete workerEnv.NODE_OPTIONS; delete workerEnv.NODE_PATH; }
  const child = fork(execution.workerScript, [resolve(root), job.key, token, String(process.pid), String(job.generation), String(deadline), JSON.stringify({ maxArtifactBytes, maxResultBytes })], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv, windowsHide: true, detached: process.platform !== 'win32',
    cwd: execution.cwd, env: workerEnv,
  });
  let timedOut = false, spawnError, logError, terminalError, response, logBytes = 0;
  const fail = error => { if (terminalError) return; terminalError = error; terminate(child); };
  child.on('message', message => { response = message; });
  publish(join(admission, 'workers', `${reservation.token}.json`), { token: reservation.token, workerPid: child.pid ?? 0 });
  if (child.pid) child.send({ start: true }, error => { if (error) { spawnError = error; terminate(child); } });
  const limiter = () => new Transform({ transform(chunk, encoding, callback) {
    const remaining = maxLogBytes === null ? chunk.length : Math.max(0, maxLogBytes - logBytes);
    logBytes += chunk.length;
    if (remaining) this.push(chunk.subarray(0, remaining));
    if (maxLogBytes !== null && logBytes > maxLogBytes) fail(new ExperimentError('LOG_LIMIT', `Worker logs exceeded ${maxLogBytes} bytes`));
    callback();
  } });
  const logs = [pipeline(child.stdout, limiter(), stdout), pipeline(child.stderr, limiter(), stderr)].map(promise => promise.catch(error => { logError = error; if (!timedOut) terminate(child); }));
  const timer = setTimeout(() => {
    timedOut = true; terminate(child);
    child.stdout.destroy(); child.stderr.destroy();
  }, timeoutMs);
  const monitor = setInterval(() => {
    try {
      const cancellation = optionalRead(join(jobDirectory, 'cancelled.json'));
      if (cancellation || signal?.aborted && shutdown === 'cancel') fail(new ExperimentError('WORKER_CANCELLED', cancellation?.reason ?? 'Runner shutdown requested cancellation'));
      assertArtifactBudget(join(path, 'artifacts'), maxArtifactBytes);
    } catch (error) { if (error.code !== 'ENOENT') fail(error); }
  }, pollMs);
  const { code, signal: exitSignal } = await new Promise(resolveExit => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timer); clearInterval(monitor);
  await Promise.all(logs);
  const claimPath = join(jobDirectory, 'claims', `${job.generation}.json`);
  let claim = optionalRead(claimPath);
  if (!claim) {
    publish(claimPath, { token, generation: job.generation, workerPid: child.pid ?? 0, supervisorPid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() });
    claim = read(claimPath);
  }
  if (claim?.token === token && !existsSync(join(path, 'finished.json'))) {
    try {
      const cancellation = optionalRead(join(jobDirectory, 'cancelled.json'));
      if (cancellation) terminalError ??= new ExperimentError('WORKER_CANCELLED', cancellation.reason);
      if (terminalError) throw terminalError;
      if (timedOut && !response?.success) throw new ExperimentError('WORKER_TIMEOUT', `Worker exceeded ${timeoutMs} ms`);
      if (logError && !response?.success) throw new ExperimentError('WORKER_LOG_IO', logError.message);
      if (!response) throw new ExperimentError('WORKER_CRASH', String(spawnError?.message ?? `Worker exited without a result (code ${code}, signal ${exitSignal})`));
      if (!response.success) throw response.error;
      assertArtifactBudget(join(path, 'artifacts'), maxArtifactBytes);
      assert(maxResultBytes === null || Buffer.byteLength(canonicalExperimentJson(response.result)) <= maxResultBytes, 'RESULT_LIMIT', `Worker result exceeded ${maxResultBytes} bytes`);
      verifyExperiment(job);
      finishExperimentAttempt(path, token, response.result);
    } catch (error) { finishExperimentAttempt(path, token, null, error); }
  }
}

/** Continuously discover submissions until drained (or idleMs elapses).
 * concurrency limits this invocation; immutable resourceBudget limits every
 * runner sharing admissionRoot. Declared memory and threads are reservations,
 * not OS RSS/CPU enforcement. Abort stops admissions; shutdown selects whether
 * owned workers finish or are cancelled. No unrelated worker is cancelled. */
export async function runQueue(root, { concurrency = 1, timeoutMs = 60_000, resourceBudget, admissionRoot, pollMs = 50, idleMs = 0, signal, shutdown = 'drain', keyPrefix = '', maxLogBytes = null, maxArtifactBytes = null, maxResultBytes = null } = {}) {
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 256, 'INVALID_CONCURRENCY', 'concurrency must be an integer in 1..256');
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647, 'INVALID_TIMEOUT', 'timeoutMs must be a positive 32-bit timer interval');
  assert(Number.isInteger(pollMs) && pollMs > 0 && pollMs <= 2_147_483_647 && Number.isInteger(idleMs) && idleMs >= 0 && idleMs <= 2_147_483_647, 'INVALID_POLL', 'pollMs must be positive and idleMs nonnegative timer intervals');
  assert(['drain', 'cancel'].includes(shutdown) && typeof keyPrefix === 'string', 'INVALID_SHUTDOWN', 'shutdown must be drain or cancel and keyPrefix must be a string');
  for (const limit of [maxLogBytes, maxArtifactBytes, maxResultBytes]) assert(limit === null || Number.isSafeInteger(limit) && limit >= 0, 'INVALID_LIMIT', 'Output limits must be nonnegative byte integers or null');
  const admission = admissionDirectory(root, admissionRoot), budget = queueBudget(admission, resourceBudget), supervisor = randomUUID();
  publish(join(admission, 'supervisors', `${supervisor}.json`), { token: supervisor, supervisorPid: process.pid, hostname: hostname(), registry: resolve(root), startedAt: new Date().toISOString() });
  const active = new Set(), options = { timeoutMs, pollMs, signal, shutdown, maxLogBytes, maxArtifactBytes, maxResultBytes };
  let idleSince = Date.now(), failure;
  try {
    while (!signal?.aborted) {
      const pending = listExperiments(root).filter(job => job.execution === 'worker' && job.status === 'queued' && job.key.startsWith(keyPrefix));
      let admitted = false;
      for (const job of pending) {
        if (active.size >= concurrency || signal?.aborted) break;
        const resources = job.resources ?? { cpuThreads: 1, memoryMiB: 0 };
        assert(resources.cpuThreads <= budget.cpuThreads && (budget.memoryMiB === null || resources.memoryMiB > 0 && resources.memoryMiB <= budget.memoryMiB), 'RESOURCE_BUDGET', `Job ${JSON.stringify(job.key)} needs declared resources fitting the shared budget`);
        const reservation = locked(admission, () => {
          const latest = inspectJob(directory(root, job.key));
          if (latest.status !== 'queued' || latest.generation !== job.generation) return false;
          const held = reservations(admission).filter(record => {
            const ownerAlive = record.hostname !== hostname() || alive(record.supervisorPid);
            // Release may be published between the reservation snapshot and
            // process probing. Refresh it after probing, both to avoid false
            // abandonment and to exclude newly released resource estimates.
            const released = existsSync(join(admission, 'released', `${record.token}.json`));
            assert(ownerAlive || released, 'ADMISSION_ABANDONED', 'A reservation supervisor exited; use recoverQueue explicitly after checking its worker');
            return !released;
          });
          if (held.some(record => record.registry === resolve(root) && record.key === job.key && record.generation === job.generation)) return false;
          const total = held.reduce((sum, record) => ({ cpuThreads: sum.cpuThreads + record.resources.cpuThreads, memoryMiB: sum.memoryMiB + record.resources.memoryMiB }), { cpuThreads: 0, memoryMiB: 0 });
          if (held.length >= budget.workers || total.cpuThreads + resources.cpuThreads > budget.cpuThreads || budget.memoryMiB !== null && total.memoryMiB + resources.memoryMiB > budget.memoryMiB) return false;
          const record = { token: randomUUID(), attemptToken: randomUUID(), supervisor, supervisorPid: process.pid, hostname: hostname(), registry: resolve(root), key: job.key, generation: job.generation, resources, admittedAt: new Date().toISOString() };
          publish(join(admission, 'reservations', `${record.token}.json`), record);
          return record;
        });
        if (!reservation) continue;
        admitted = true;
        const task = execute(root, job, options, reservation, admission).catch(error => { failure ??= error; }).finally(() => { releaseReservation(admission, reservation.token, 'worker-exited'); active.delete(task); });
        active.add(task);
      }
      if (failure) throw failure;
      if (admitted || active.size || pending.length) idleSince = Date.now();
      else if (Date.now() - idleSince >= idleMs) break;
      await delay(pollMs);
    }
  } finally {
    await Promise.all(active);
    publish(join(admission, 'supervisor-finished', `${supervisor}.json`), { token: supervisor, status: signal?.aborted ? 'stopped' : 'drained', finishedAt: new Date().toISOString() });
  }
  if (failure) throw failure;
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
