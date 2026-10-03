import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freeze, hash, nat, requireThat } from './core.mjs';
import { canonicalExperimentJson, deterministicSeed, prepareExperiment, listExperiments, readExperimentResult, runQueue } from './experiments.mjs';
import { selectStudy } from './study.mjs';
import { verifiedRuntimeProvenance } from './provenance.mjs';
import { publishImmutable } from './immutable-files.mjs';

const terminal = new Set(['completed', 'failed', 'abandoned', 'cancelled']);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const optionalRead = path => { try { return read(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const same = (a, b) => canonicalExperimentJson(a) === canonicalExperimentJson(b);
const copy = value => JSON.parse(canonicalExperimentJson(value));
const within = (directory, path) => { const name = relative(directory, path); return name === '' || !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`); };

const publish = (path, value) => publishImmutable(path, canonicalExperimentJson(value) + '\n');

function specification(input, root) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'CAMPAIGN_SPEC', 'Declare a campaign specification');
  const allowed = ['id', 'datasetHash', 'planHash', 'comparisonHash', 'protocol', 'maxTrials', 'selectionMetric', 'resourceBudget', 'finalAuthorityDirectory', 'workerIsolation'];
  requireThat(Object.keys(input).every(key => allowed.includes(key)), 'CAMPAIGN_SPEC', 'Unknown campaign specification option');
  requireThat(typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 1024 && !input.id.includes('\0'), 'CAMPAIGN_SPEC', 'Declare a nonempty campaign ID');
  for (const name of ['datasetHash', 'planHash', 'comparisonHash']) requireThat(typeof input[name] === 'string' && /^[0-9a-f]{64}$/.test(input[name]) && input[name] !== '0'.repeat(64), 'CAMPAIGN_SPEC', `Declare a nonzero SHA-256 ${name}`);
  requireThat(Number.isSafeInteger(input.maxTrials) && input.maxTrials > 0, 'CAMPAIGN_BUDGET', 'maxTrials must be a positive safe integer');
  const finalAuthorityDirectory = input.finalAuthorityDirectory ?? join(dirname(root), '.final-authority');
  requireThat(typeof finalAuthorityDirectory === 'string' && isAbsolute(finalAuthorityDirectory), 'CAMPAIGN_AUTHORITY', 'Pin an absolute shared final authority directory');
  requireThat(resolve(finalAuthorityDirectory) !== root && !within(join(root, 'experiments'), resolve(finalAuthorityDirectory)), 'CAMPAIGN_AUTHORITY', 'Final authority must be separate from exploration registry and attempt files');
  const workerIsolation = input.workerIsolation ?? 'filesystem';
  requireThat(['filesystem', 'trusted'].includes(workerIsolation), 'CAMPAIGN_ISOLATION', 'Worker isolation must be filesystem or trusted');
  const protocol = copy(input.protocol);
  requireThat(protocol && Object.keys(protocol).every(key => ['warmup', 'account', 'intervalMs', 'periodsPerYear', 'maxStalenessMs'].includes(key)) && protocol.warmup === 'history-only' && protocol.account === 'reset-per-fold', 'STUDY_PROTOCOL', 'Declare the existing validation study protocol');
  nat(protocol.intervalMs, 'intervalMs', true); nat(protocol.maxStalenessMs, 'maxStalenessMs');
  requireThat(Number.isFinite(protocol.periodsPerYear) && protocol.periodsPerYear > 0, 'STUDY_PROTOCOL', 'Declare a positive annualization frequency');
  requireThat(input.selectionMetric === undefined || input.selectionMetric === 'aggregate-validation-return', 'CAMPAIGN_METRIC', 'Campaigns select aggregate validation return');
  const resourceBudget = { workers: 1, cpuThreads: 1, ...copy(input.resourceBudget ?? {}) };
  requireThat(Object.keys(resourceBudget).every(key => ['workers', 'cpuThreads', 'memoryMiB'].includes(key)) && Number.isInteger(resourceBudget.workers) && resourceBudget.workers >= 1 && resourceBudget.workers <= 256 && Number.isSafeInteger(resourceBudget.cpuThreads) && resourceBudget.cpuThreads > 0 && (resourceBudget.memoryMiB === undefined || Number.isSafeInteger(resourceBudget.memoryMiB) && resourceBudget.memoryMiB > 0), 'CAMPAIGN_RESOURCES', 'Declare positive worker, CPU thread and optional memory budgets');
  const body = { format: 'campaign-v1', id: input.id, datasetHash: input.datasetHash, planHash: input.planHash, comparisonHash: input.comparisonHash, protocol, maxTrials: input.maxTrials, selectionMetric: 'aggregate-validation-return', resourceBudget, finalAuthorityDirectory: resolve(finalAuthorityDirectory), workerIsolation };
  return freeze({ ...body, specificationHash: hash(body) });
}

function localUrl(value) {
  const url = value instanceof URL ? value : typeof value === 'string' && value.startsWith('file:') ? new URL(value) : pathToFileURL(resolve(value));
  requireThat(url.protocol === 'file:' && !url.search && !url.hash, 'CAMPAIGN_WORKER', 'Workers and dependencies must be local file URLs without query or fragment');
  return pathToFileURL(fileURLToPath(url)).href;
}

/** Own a complete research population behind one local-filesystem seam.
 * comparisonHash comes from a preflight evaluateStudy with the intended data,
 * folds, baseline signals and execution assumptions. finalAuthorityDirectory
 * pins the shared final-release location across campaign roots. Creation/inspection needs
 * no compiled runtime. Submission uses the existing verified experiment seam.
 * All writers must use this module; it is a cooperative trusted-worker contract.
 */
export function createCampaign(directory, input) {
  const root = resolve(directory), spec = specification(input, root), registryRoot = join(root, 'experiments');
  const specPath = join(root, 'campaign.json');
  publish(specPath, spec);
  requireThat(same(read(specPath), spec), 'CAMPAIGN_COLLISION', 'Campaign root already has a different immutable specification');
  const statePath = revision => join(root, 'membership', `${revision}.json`);
  const stateRecord = (current, event) => {
    const body = { format: 'campaign-membership-event-v1', campaignHash: spec.specificationHash, revision: current.revision + 1, previousHash: current.hash, event };
    return { ...body, hash: hash(body) };
  };
  const initial = stateRecord({ revision: -1, hash: null }, { type: 'created' });
  publish(statePath(0), initial);
  const cached = { revision: -1, hash: null, sealed: false, members: new Map() };
  function apply(record) {
    const { hash: digest, ...body } = record;
    requireThat(digest === hash(body) && record.campaignHash === spec.specificationHash && record.format === 'campaign-membership-event-v1' && record.revision === cached.revision + 1 && record.previousHash === cached.hash, 'CAMPAIGN_CORRUPT', 'Invalid immutable campaign membership event');
    const { event } = record;
    if (event.type === 'created') requireThat(record.revision === 0, 'CAMPAIGN_CORRUPT', 'Campaign creation must be the first event');
    else if (event.type === 'reserve') {
      requireThat(!cached.sealed && !cached.members.has(event.member.id) && cached.members.size < spec.maxTrials, 'CAMPAIGN_CORRUPT', 'Invalid campaign admission event');
      cached.members.set(event.member.id, { ...event.member, specificationHash: null, configurationHash: null });
    } else if (event.type === 'bind') {
      const member = cached.members.get(event.id);
      requireThat(member && member.specificationHash === null && /^[0-9a-f]{64}$/.test(event.specificationHash) && /^[0-9a-f]{64}$/.test(event.configurationHash), 'CAMPAIGN_CORRUPT', 'Invalid campaign registration event');
      cached.members.set(event.id, { ...member, specificationHash: event.specificationHash, configurationHash: event.configurationHash });
    } else if (event.type === 'seal') { requireThat(!cached.sealed, 'CAMPAIGN_CORRUPT', 'Campaign was already sealed'); cached.sealed = true; }
    else requireThat(false, 'CAMPAIGN_CORRUPT', 'Unknown campaign membership event');
    cached.revision = record.revision; cached.hash = record.hash;
  }
  function state() {
    let next;
    while ((next = optionalRead(statePath(cached.revision + 1)))) apply(next);
    return cached;
  }
  function advance(change) {
    for (;;) {
      const current = state(), event = change(current);
      if (!event) return current;
      const next = stateRecord(current, event);
      if (publish(statePath(next.revision), next)) { apply(next); return cached; }
    }
  }
  function submit(job) {
    requireThat(job && Object.keys(job).every(key => ['key', 'configuration', 'workerModule', 'dependencies', 'seed', 'resources', 'sourceRoot', 'inputFiles'].includes(key)), 'CAMPAIGN_JOB', 'Unknown campaign job option');
    requireThat(typeof job.key === 'string' && job.key.length > 0 && job.key.length <= 1024 && !job.key.includes('\0'), 'INVALID_KEY', 'Declare a nonempty trial key');
    const configuration = copy(job.configuration);
    requireThat(configuration && typeof configuration === 'object' && !Array.isArray(configuration) && !Object.hasOwn(configuration, 'campaign'), 'CAMPAIGN_JOB', 'Configuration must be an object without reserved campaign metadata');
    const seed = job.seed ?? deterministicSeed(job.key);
    requireThat(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'INVALID_SEED', 'seed must be an unsigned 32-bit integer');
    requireThat(job.dependencies === undefined || Array.isArray(job.dependencies), 'DEPENDENCIES', 'dependencies must be an array');
    const resources = { cpuThreads: 1, memoryMiB: 0, ...copy(job.resources ?? {}) };
    requireThat(Object.keys(resources).every(key => ['cpuThreads', 'memoryMiB'].includes(key)) && Number.isSafeInteger(resources.cpuThreads) && resources.cpuThreads > 0 && resources.cpuThreads <= spec.resourceBudget.cpuThreads && Number.isSafeInteger(resources.memoryMiB) && resources.memoryMiB >= 0 && (spec.resourceBudget.memoryMiB === undefined || resources.memoryMiB > 0 && resources.memoryMiB <= spec.resourceBudget.memoryMiB), 'CAMPAIGN_RESOURCES', 'Trial resource declaration must fit the frozen campaign budget; bounded memory requires a positive declaration');
    requireThat(job.inputFiles === undefined || job.inputFiles && Object.getPrototypeOf(job.inputFiles) === Object.prototype, 'CAMPAIGN_INPUT', 'inputFiles must map configuration JSON pointers to local source files');
    const inputFiles = Object.fromEntries(Object.entries(job.inputFiles ?? {}).map(([pointer, path]) => {
      requireThat(pointer !== '/campaign' && !pointer.startsWith('/campaign/'), 'CAMPAIGN_INPUT', 'Input files cannot replace reserved campaign metadata');
      return [pointer, localUrl(path)];
    }));
    const submitted = { key: job.key, configuration, workerModule: localUrl(job.workerModule), dependencies: [...new Set((job.dependencies ?? []).map(localUrl))].sort(), seed, resources, frozen: true, constrained: spec.workerIsolation === 'filesystem', inputFiles, ...(job.sourceRoot === undefined ? {} : { sourceRoot: fileURLToPath(localUrl(job.sourceRoot)) }) };
    requireThat([submitted.workerModule, ...submitted.dependencies, ...Object.values(inputFiles)].every(url => !within(spec.finalAuthorityDirectory, fileURLToPath(url))) && (submitted.sourceRoot === undefined || !within(spec.finalAuthorityDirectory, submitted.sourceRoot)), 'CAMPAIGN_AUTHORITY', 'Exploration workers and inputs cannot be taken from the final authority directory');
    const request = { ...submitted, configuration: { ...configuration, campaign: { id: spec.id, specificationHash: spec.specificationHash, submissionHash: hash(submitted) } } };
    const current = state(), existing = current.members.get(job.key);
    if (existing) {
      requireThat(same(existing.request, request), 'CAMPAIGN_TRIAL_COLLISION', 'Trial key already has a different submission');
      if (existing.specificationHash === null) {
        const registered = listExperiments(registryRoot).find(manifest => manifest.key === job.key);
        if (registered) { bind(registered); return freeze(copy(registered)); }
      }
    } else {
      requireThat(!current.sealed, 'CAMPAIGN_SEALED', 'Sealed campaign cannot accept new trials');
      requireThat(current.members.size < spec.maxTrials, 'CAMPAIGN_BUDGET', 'Campaign search budget is exhausted');
    }
    for (const url of [request.workerModule, ...request.dependencies, ...Object.values(inputFiles)]) requireThat(statSync(fileURLToPath(url)).isFile(), 'CAMPAIGN_WORKER', 'Worker dependencies must be regular files');
    verifiedRuntimeProvenance();
    // Freeze before reservation: malformed inputs consume no search budget and
    // registration uses exactly these verified bytes despite concurrent edits.
    const register = prepareExperiment(registryRoot, request);
    advance(current => {
      const existing = current.members.get(job.key);
      if (existing) { requireThat(same(existing.request, request), 'CAMPAIGN_TRIAL_COLLISION', 'Trial key already has a different submission'); return null; }
      requireThat(!current.sealed, 'CAMPAIGN_SEALED', 'Sealed campaign cannot accept new trials');
      requireThat(current.members.size < spec.maxTrials, 'CAMPAIGN_BUDGET', 'Campaign search budget is exhausted');
      return { type: 'reserve', member: { id: job.key, request } };
    });
    // A crash here leaves a durable, visible reservation. The identical submit
    // resumes registration even after sealing; no failed admission is omitted.
    const manifest = register();
    bind(manifest);
    return freeze(copy(manifest));
  }
  function bind(manifest) {
    advance(current => {
      const existing = current.members.get(manifest.key);
      requireThat(existing && same(existing.request.configuration.campaign, manifest.configuration?.campaign) && existing.request.seed === manifest.seed, 'CAMPAIGN_TRIAL_COLLISION', 'Registered trial does not match its reserved campaign submission');
      requireThat(manifest.bundle && manifest.constrained === (spec.workerIsolation === 'filesystem') && same(manifest.resources, existing.request.resources), 'CAMPAIGN_ISOLATION', 'Campaign trials require frozen execution and their declared isolation and resources');
      requireThat(existing.specificationHash === null || existing.specificationHash === manifest.specificationHash, 'CAMPAIGN_TRIAL_COLLISION', 'Registered trial specification changed');
      if (existing.specificationHash === manifest.specificationHash) return null;
      return { type: 'bind', id: manifest.key, specificationHash: manifest.specificationHash, configurationHash: manifest.configurationHash };
    });
  }
  function seal() { advance(current => current.sealed ? null : { type: 'seal' }); return report(); }
  function report() {
    const jobs = listExperiments(registryRoot), byId = new Map(jobs.map(job => [job.key, job]));
    let membership = state();
    requireThat(jobs.every(job => membership.members.has(job.key)), 'CAMPAIGN_FOREIGN_JOB', 'Campaign registry contains a trial outside its registered population');
    for (const member of membership.members.values()) if (member.specificationHash === null && byId.has(member.id)) bind(byId.get(member.id));
    membership = state();
    const trials = [];
    const population = [...membership.members.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(member => {
      const job = byId.get(member.id);
      if (!job || member.specificationHash === null) return { id: member.id, status: 'unregistered', specificationHash: member.specificationHash, seed: member.request.seed, configurationHash: hash(member.request.configuration), attempts: [], error: null };
      requireThat(job.specificationHash === member.specificationHash && job.configurationHash === member.configurationHash && same(job.configuration.campaign, member.request.configuration.campaign), 'CAMPAIGN_TRIAL_COLLISION', 'Trial does not match its campaign admission');
      let study = null;
      const error = job.attempts.at(-1)?.error ?? null;
      if (job.status === 'completed') {
        const result = readExperimentResult(registryRoot, job.key);
        study = result?.format === 'validation-study-v1' ? result : result?.study ?? null;
        requireThat(study && study.datasetHash === spec.datasetHash && study.planHash === spec.planHash && study.comparisonHash === spec.comparisonHash && same(study.protocol, spec.protocol), 'CAMPAIGN_STUDY_MISMATCH', 'Completed study does not match the campaign data, folds, protocol and comparison');
      }
      trials.push({ id: member.id, status: job.status, study, error: error?.message ?? error });
      return { id: member.id, status: job.status, specificationHash: job.specificationHash, seed: job.seed, configurationHash: job.configurationHash, attempts: copy(job.attempts), error };
    });
    const complete = membership.sealed && population.every(trial => terminal.has(trial.status));
    const selection = complete ? selectStudy(trials) : null;
    const body = { format: 'campaign-report-v1', campaignHash: spec.specificationHash, sealed: membership.sealed, complete, status: complete ? 'complete' : membership.sealed ? 'sealed' : 'open', population, selection };
    const value = { ...body, hash: hash(body) }, reportPath = join(root, 'report.json'), official = optionalRead(reportPath);
    if (official) requireThat(same(official, value), 'CAMPAIGN_REPORT_CHANGED', 'Frozen campaign population or selection changed after completion');
    else if (complete) { publish(reportPath, value); requireThat(same(read(reportPath), value), 'CAMPAIGN_REPORT_CHANGED', 'Concurrent campaign completion disagrees'); }
    return freeze(value);
  }
  async function run(options = {}) {
    requireThat(options.resourceBudget === undefined || same(options.resourceBudget, spec.resourceBudget), 'CAMPAIGN_RESOURCES', 'Runner cannot override the frozen campaign resource budget');
    report();
    await runQueue(registryRoot, { ...options, resourceBudget: spec.resourceBudget });
    return report();
  }
  return Object.freeze({ root, registryRoot, spec, submit, seal, run, report });
}
