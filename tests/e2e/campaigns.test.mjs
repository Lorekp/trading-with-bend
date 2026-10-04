import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createCampaign } from '../../src/campaigns.mjs';
import { withVerifiedPreflight } from '../../src/campaign-preflight.mjs';
import { hash } from '../../src/core.mjs';
import { enqueueExperiment, listExperiments, runQueue } from '../../src/experiments.mjs';
import { evaluateStudy } from '../../src/study.mjs';
import { walkForwardSplits } from '../../src/evaluation.mjs';
import { QuoteExecutionVenue } from '../../src/execution-venue.mjs';
import { quoteInformationSource } from '../../src/information-source.mjs';
import { targetPosition } from '../../src/strategies.mjs';
import { sourceManifest } from '../../src/provenance.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));

test('verified preflight resumes after capacity stops, preserving evidence and gating real campaign admission', async t => {
  const f = await fixture(t), registry = join(f.directory, 'diagnostics'), directory = join(f.directory, 'preflight');
  const key = 'cash-diagnostic';
  enqueueExperiment(registry, { ...f.job(key), frozen: true, constrained: true });
  const identityHash = hash({ spec: f.spec, candidates: ['candidate'], worker: readFileSync(f.workerModule, 'utf8') });
  let checks = 0, admissions = 0, freeBytes = 0;
  const options = { directory, identityHash, diagnostic: { registry, key }, checkCapacity({ result, originalStop }) {
    checks++;
    assert.equal(result.study.hash, f.study.hash);
    if (checks > 1) assert.equal(originalStop.capacity.freeBytes, 0);
    return { allowed: freeBytes >= 100, freeBytes, requiredBytes: 100 };
  } };
  const admit = ({ result, capacity }) => {
    admissions++;
    assert.equal(result.study.hash, f.study.hash); assert.equal(capacity.allowed, true);
    return f.campaign.submit(f.job('candidate'));
  };
  await assert.rejects(withVerifiedPreflight(options, admit), { code: 'PREFLIGHT_DIAGNOSTIC' });
  assert.equal(checks, 0);
  await runQueue(registry, { timeoutMs: 30000 });
  const diagnosticBefore = listExperiments(registry);
  await assert.rejects(withVerifiedPreflight(options, admit), { code: 'CAMPAIGN_CAPACITY' });
  const stopPath = join(directory, 'stop.json'), original = readFileSync(stopPath, 'utf8');
  assert.equal(f.campaign.report().population.length, 0);
  freeBytes = 50;
  await assert.rejects(withVerifiedPreflight(options, admit), { code: 'CAMPAIGN_CAPACITY' });
  assert.equal(readFileSync(stopPath, 'utf8'), original);
  freeBytes = 200;
  await assert.rejects(withVerifiedPreflight({ ...options, identityHash: hash('changed candidates') }, admit), { code: 'PREFLIGHT_IDENTITY' });
  assert.equal(checks, 2);
  // Artifacts, result and frozen bundle are reverified before every capacity check.
  const attempt = diagnosticBefore[0].attempts.at(-1);
  for (const path of [join(attempt.outputDirectory, 'validation.json'), attempt.resultPath]) {
    const saved = readFileSync(path);
    writeFileSync(path, '{}');
    await assert.rejects(withVerifiedPreflight(options, admit), error => ['RESULT_CHANGED', 'ARTIFACT_CHANGED'].includes(error.code));
    writeFileSync(path, saved);
  }
  assert.equal(checks, 2);
  await withVerifiedPreflight(options, admit);
  assert.equal(checks, 3); assert.equal(admissions, 1);
  assert.equal(readFileSync(stopPath, 'utf8'), original);
  assert.equal(readdirSync(join(directory, 'checks')).length, 3);
  assert.deepEqual(listExperiments(registry), diagnosticBefore, 'Diagnostic must not be rerun or recovered');
  f.campaign.seal();
  const report = await f.campaign.run({ timeoutMs: 30000 });
  assert.equal(report.complete, true); assert.equal(report.population.length, 1);
  // A previous successful capacity check never authorizes a later call.
  freeBytes = 0;
  await assert.rejects(withVerifiedPreflight(options, admit), { code: 'CAMPAIGN_CAPACITY' });
  assert.equal(admissions, 1);
  await assert.rejects(withVerifiedPreflight({ ...options, checkCapacity: () => { throw new Error('measurement failed'); } }, admit), /measurement failed/);
  assert.equal(readFileSync(stopPath, 'utf8'), original);
  const corrupt = JSON.parse(original); corrupt.capacity.freeBytes = 999;
  writeFileSync(stopPath, JSON.stringify(corrupt));
  await assert.rejects(withVerifiedPreflight(options, admit), { code: 'PREFLIGHT_CORRUPT' });
  writeFileSync(stopPath, original);
  const bundleFile = join(diagnosticBefore[0].bundle.path, 'experiments/test/worker.mjs');
  writeFileSync(bundleFile, 'export default () => null;');
  await assert.rejects(withVerifiedPreflight(options, admit), { code: 'BUNDLE_CORRUPT' });
});

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bend-campaign-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const instrument = { symbol: 'CAMPAIGN', currency: 'EUR', lotSize: '1', priceTick: '1' };
  const ticks = Array.from({ length: 12 }, (_, index) => ({ id: `q${index}`, type: 'tick', time: String(index * 10), sourceTime: String(index * 10), sequence: String(index + 1), symbol: instrument.symbol, currency: instrument.currency, bid: String(100 + index), ask: String(101 + index), bidLots: '10', askLots: '10' }));
  const samples = ticks.map(row => ({ id: row.id, time: row.time, labelAvailableAt: String(BigInt(row.time) + 1n) }));
  const plan = walkForwardSplits(samples, { trainSize: 3, validationSize: 3, finalStart: 9 });
  const protocol = { warmup: 'history-only', account: 'reset-per-fold', intervalMs: '10', periodsPerYear: 252, maxStalenessMs: '0' };
  const config = { instrument, initialCash: '1000', feePerLot: '0', orderLatencyMs: '1', cancelLatencyMs: '0', maxQuoteAgeMs: '10', manifest: { datasetVersion: 'campaign-fixture', strategyArtifact: 'candidate', evaluationProtocol: 'validation', seed: '1' } };
  const study = await evaluateStudy({ samples, plan, protocol }, () => ({ strategy: targetPosition('1'), baselines: { cash: targetPosition('0') }, createReplay: () => ({ informationSource: quoteInformationSource({ id: 'campaign-information', instrument, ticks }), executionVenue: new QuoteExecutionVenue({ id: 'campaign-venue', config, ticks, maxPositionLots: '1' }) }) }));
  const spec = { id: 'population', datasetHash: study.datasetHash, planHash: study.planHash, comparisonHash: study.comparisonHash, protocol, maxTrials: 6, resourceBudget: { workers: 2, cpuThreads: 2 }, finalAuthorityDirectory: join(directory, 'final-authority'), ...options };
  const root = join(directory, 'campaign'), sourceRoot = join(directory, 'checkout'), workerModule = join(sourceRoot, 'experiments/test/worker.mjs');
  for (const name of [...Object.keys(sourceManifest()), 'build/verification.json']) {
    const target = join(sourceRoot, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repository, name), target);
  }
  cpSync(join(repository, 'node_modules'), join(sourceRoot, 'node_modules'), { recursive: true });
  mkdirSync(dirname(workerModule), { recursive: true });
  writeFileSync(workerModule, `export default async function(configuration, context) {
    if (configuration.delay) await new Promise(resolve => setTimeout(resolve, configuration.delay));
    if (configuration.fail) throw new Error('training failed');
    context.writeArtifact('validation.json', configuration.study);
    return { study: configuration.study };
  }\n`);
  const job = (key, extra = {}) => ({ key, workerModule, sourceRoot, configuration: { study, ...extra } });
  return { directory, root, spec, workerModule, sourceRoot, study, job, campaign: createCampaign(root, spec) };
}

test('campaign selection owns the sealed complete population, failures, ties and immutable outcomes', async t => {
  const { campaign, root, spec, job } = await fixture(t);
  const first = campaign.submit(job('b'));
  assert.equal(campaign.submit(job('b')).specificationHash, first.specificationHash);
  campaign.submit(job('a'));
  campaign.submit(job('failed', { fail: true }));
  assert.throws(() => campaign.submit(job('b', { fail: true })), { code: 'CAMPAIGN_TRIAL_COLLISION' });
  const running = await campaign.run({ concurrency: 2, timeoutMs: 30000 });
  assert.equal(running.selection, null, 'Completed but unsealed searches cannot select');
  assert.deepEqual(running.population.map(row => [row.id, row.status]), [['a', 'completed'], ['b', 'completed'], ['failed', 'failed']]);
  const official = campaign.seal();
  const events = readdirSync(join(root, 'membership')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(root, 'membership', name), 'utf8')));
  assert.equal(events.filter(record => record.event.type === 'reserve').length, 3);
  assert.ok(events.every(record => !Object.hasOwn(record, 'members')), 'Journal stores admissions once, rather than full population snapshots');
  assert.equal(official.status, 'complete');
  assert.equal(official.selection.selectedId, 'a');
  assert.deepEqual(official.selection.population.map(row => [row.id, row.valid]), [['a', true], ['b', true], ['failed', false]]);
  assert.match(official.population.at(-1).error.message, /training failed/);
  assert.ok(Object.isFrozen(official.population[0].attempts));
  assert.throws(() => campaign.submit(job('late')), { code: 'CAMPAIGN_SEALED' });
  assert.equal(campaign.submit(job('a')).specificationHash, official.population[0].specificationHash);
  assert.deepEqual(createCampaign(root, spec).report(), official);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')), official);
  assert.throws(() => createCampaign(root, { ...spec, maxTrials: 9 }), { code: 'CAMPAIGN_COLLISION' });
});

test('campaign validates admissions before consuming search budget and withholds queued population selection', async t => {
  const { campaign, job, directory, spec } = await fixture(t, { maxTrials: 1, resourceBudget: { workers: 1, cpuThreads: 2, memoryMiB: 128 } });
  assert.throws(() => campaign.submit(job('invalid')), { code: 'CAMPAIGN_RESOURCES' });
  assert.throws(() => campaign.submit({ ...job('invalid'), resources: { cpuThreads: 3, memoryMiB: 128 } }), { code: 'CAMPAIGN_RESOURCES' });
  const outside = join(directory, 'outside-helper.mjs'); writeFileSync(outside, 'export const value = 1;\n');
  assert.throws(() => campaign.submit({ ...job('invalid-helper'), resources: { cpuThreads: 1, memoryMiB: 128 }, dependencies: [outside] }), { code: 'BUNDLE_PATH' });
  const input = join(directory, 'input.json'); writeFileSync(input, 'validation');
  const inputJob = { ...job('invalid-input', { file: input }), resources: { memoryMiB: 128 } };
  assert.throws(() => campaign.submit({ ...inputJob, inputFiles: { '/missing': input } }), { code: 'BUNDLE_INPUT' });
  assert.throws(() => campaign.submit({ ...inputJob, inputFiles: { 'file': input } }), { code: 'BUNDLE_INPUT' });
  assert.throws(() => campaign.submit({ ...inputJob, inputFiles: { '/file': outside } }), { code: 'BUNDLE_INPUT' });
  const reservedMetadata = createCampaign(join(directory, 'reserved-metadata-campaign'), { ...spec, id: input });
  assert.throws(() => reservedMetadata.submit({ ...inputJob, inputFiles: { '/campaign/id': input } }), { code: 'CAMPAIGN_INPUT' });
  assert.equal(reservedMetadata.report().population.length, 0);
  assert.equal(campaign.report().population.length, 0);
  campaign.submit({ ...job('accepted'), resources: { cpuThreads: 2, memoryMiB: 128 } });
  assert.throws(() => campaign.submit({ ...job('over-budget'), resources: { memoryMiB: 64 } }), { code: 'CAMPAIGN_BUDGET' });
  const incomplete = campaign.seal();
  assert.equal(incomplete.status, 'sealed'); assert.equal(incomplete.selection, null);
  assert.equal(incomplete.population[0].status, 'queued');
  await assert.rejects(campaign.run({ resourceBudget: { workers: 8, cpuThreads: 8 } }), { code: 'CAMPAIGN_RESOURCES' });
  const complete = await campaign.run({ timeoutMs: 30000 });
  assert.equal(complete.selection.selectedId, 'accepted');
});

function child(code, arguments_) {
  return new Promise((resolveChild, reject) => {
    const process_ = spawn(process.execPath, ['--input-type=module', '-e', code, ...arguments_], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process_.stdout.on('data', data => { stdout += data; }); process_.stderr.on('data', data => { stderr += data; });
    process_.once('error', reject);
    process_.once('close', status => status === 0 ? resolveChild(JSON.parse(stdout)) : reject(new Error(`Campaign child exited ${status}: ${stderr}`)));
  });
}

test('independent agents submit and seal through one atomic membership seam without omitted admissions', async t => {
  const { campaign, directory, root, spec, job } = await fixture(t, { maxTrials: 3 });
  const payload = join(directory, 'input.json');
  writeFileSync(payload, JSON.stringify({ root, spec, job: job('shared') }));
  const code = `import {readFileSync} from 'node:fs'; import {createCampaign} from ${JSON.stringify(new URL('../../src/campaigns.mjs', import.meta.url).href)};
    const {root,spec,job}=JSON.parse(readFileSync(process.argv[1],'utf8')); const campaign=createCampaign(root,spec);
    try { if(process.argv[2]==='seal') campaign.seal(); else campaign.submit({...job,key:process.argv[2]}); console.log(JSON.stringify({key:process.argv[2],accepted:true})); }
    catch(error) { if(!['CAMPAIGN_SEALED','CAMPAIGN_BUDGET'].includes(error.code)) throw error; console.log(JSON.stringify({key:process.argv[2],accepted:false,code:error.code})); }`;
  const duplicates = await Promise.all(Array.from({ length: 3 }, () => child(code, [payload, 'shared'])));
  assert.ok(duplicates.every(row => row.accepted));
  const contenders = await Promise.all(['a', 'b', 'c', 'seal'].map(key => child(code, [payload, key])));
  const population = campaign.report().population;
  assert.equal(campaign.report().sealed, true);
  assert.ok(population.length <= 3);
  const admitted = new Set(['shared', ...contenders.filter(row => row.accepted && row.key !== 'seal').map(row => row.key)]);
  assert.deepEqual(new Set(population.map(row => row.id)), admitted);
  assert.ok(population.every(row => row.status === 'queued'));
  const complete = await campaign.run({ timeoutMs: 30000 });
  assert.equal(complete.complete, true);
  assert.equal(complete.selection.population.length, admitted.size);
});

test('campaign refuses foreign registry trials rather than omitting them from selection', async t => {
  const { campaign, workerModule, study } = await fixture(t);
  enqueueExperiment(campaign.registryRoot, { key: 'foreign', workerModule, configuration: { study } });
  assert.throws(() => campaign.report(), { code: 'CAMPAIGN_FOREIGN_JOB' });
  await assert.rejects(campaign.run(), { code: 'CAMPAIGN_FOREIGN_JOB' });
});

test('a supervisor interruption after manifest publication resumes admission without mutable worker sources', async t => {
  const { campaign, directory, root, spec, job, workerModule } = await fixture(t);
  const payload = join(directory, 'interrupted.json'), original = readFileSync(workerModule);
  writeFileSync(payload, JSON.stringify({ root, spec, job: job('interrupted') }));
  const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.linkSync; fs.linkSync=(source,target)=>{ original(source,target); if(target.endsWith('manifest.json')) {console.log(JSON.stringify({interrupted:true}));process.exit(0);} }; syncBuiltinESMExports();
    const {createCampaign}=await import(${JSON.stringify(new URL('../../src/campaigns.mjs', import.meta.url).href)});
    const {root,spec,job}=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); createCampaign(root,spec).submit(job);`;
  assert.deepEqual(await child(code, [payload]), { interrupted: true });
  rmSync(workerModule);
  const reopened = createCampaign(root, spec);
  const resumed = reopened.report();
  assert.equal(resumed.population[0].status, 'queued');
  assert.equal(resumed.population[0].specificationHash, listExperiments(campaign.registryRoot)[0].specificationHash);
  assert.equal(resumed.selection, null);
  reopened.seal();
  writeFileSync(workerModule, original);
  assert.equal((await reopened.run({ timeoutMs: 30000 })).selection.selectedId, 'interrupted');
});

test('campaign registration keeps admitted bytes when original sources change during reservation', async t => {
  const { campaign, directory, root, spec, job } = await fixture(t);
  const input = join(directory, 'input.json'), payload = join(directory, 'during-reservation.json');
  writeFileSync(input, 'original validation input');
  writeFileSync(payload, JSON.stringify({ root, spec, input, job: { ...job('frozen', { file: input }), inputFiles: { '/file': input } } }));
  const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const payload=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    const original=fs.linkSync; fs.linkSync=(source,target)=>{ original(source,target);
      if(target.includes('membership') && JSON.parse(fs.readFileSync(target,'utf8')).event.type==='reserve') {
        fs.writeFileSync(payload.job.workerModule,'throw new Error("source changed after admission");');
        fs.writeFileSync(payload.input,'changed input');
      }
    }; syncBuiltinESMExports();
    const {createCampaign}=await import(${JSON.stringify(new URL('../../src/campaigns.mjs', import.meta.url).href)});
    console.log(JSON.stringify(createCampaign(payload.root,payload.spec).submit(payload.job)));`;
  const manifest = await child(code, [payload]);
  assert.equal(manifest.configuration.file, manifest.bundle.inputFiles['/file'].path);
  assert.equal(readFileSync(manifest.configuration.file, 'utf8'), 'original validation input');
  campaign.seal();
  assert.equal((await campaign.run({ timeoutMs: 30000 })).selection.selectedId, 'frozen');
});

test('completed studies must match every frozen campaign identity', async t => {
  for (const identity of ['datasetHash', 'planHash', 'comparisonHash', 'protocol']) {
    const { campaign, job, study } = await fixture(t);
    const changed = structuredClone(study);
    changed[identity] = identity === 'protocol' ? { ...changed.protocol, periodsPerYear: 365 } : hash(`different-${identity}`);
    delete changed.hash; changed.hash = hash(changed);
    campaign.submit(job('wrong-study', { study: changed }));
    campaign.seal();
    await runQueue(campaign.registryRoot, { timeoutMs: 30000 });
    assert.equal(listExperiments(campaign.registryRoot)[0].status, 'completed');
    assert.throws(() => campaign.report(), { code: 'CAMPAIGN_STUDY_MISMATCH' });
  }
});
