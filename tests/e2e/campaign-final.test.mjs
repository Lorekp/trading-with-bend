import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCampaign } from '../../src/campaigns.mjs';
import { releaseCampaignFinal } from '../../src/campaign-final.mjs';
import { hash } from '../../src/core.mjs';
import { evaluateStudy } from '../../src/study.mjs';
import { walkForwardSplits } from '../../src/evaluation.mjs';
import { QuoteExecutionVenue } from '../../src/execution-venue.mjs';
import { quoteInformationSource } from '../../src/information-source.mjs';
import { targetPosition } from '../../src/strategies.mjs';
import { sourceManifest } from '../../src/provenance.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(t, { planOptions = {}, ...options } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bend-campaign-final-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const instrument = { symbol: 'FINAL', currency: 'EUR', lotSize: '1', priceTick: '1' };
  const ticks = Array.from({ length: 12 }, (_, index) => ({ id: `q${index}`, type: 'tick', time: String(index * 10), sourceTime: String(index * 10), sequence: String(index + 1), symbol: instrument.symbol, currency: instrument.currency, bid: String(100 + index), ask: String(101 + index), bidLots: '10', askLots: '10' }));
  const samples = ticks.map(row => ({ id: row.id, time: row.time, labelAvailableAt: String(BigInt(row.time) + 1n) }));
  const plan = walkForwardSplits(samples, { trainSize: 3, validationSize: 3, finalStart: 9, ...planOptions });
  const protocol = { warmup: 'history-only', account: 'reset-per-fold', intervalMs: '10', periodsPerYear: 252, maxStalenessMs: '0' };
  const config = { instrument, initialCash: '1000', feePerLot: '0', orderLatencyMs: '1', cancelLatencyMs: '0', maxQuoteAgeMs: '10', manifest: { datasetVersion: 'final-fixture', strategyArtifact: 'candidate', evaluationProtocol: 'validation', seed: '1' } };
  const study = await evaluateStudy({ samples, plan, protocol }, () => ({ strategy: targetPosition('1'), baselines: { cash: targetPosition('0') }, createReplay: () => ({ informationSource: quoteInformationSource({ id: 'final-information', instrument, ticks }), executionVenue: new QuoteExecutionVenue({ id: 'final-venue', config, ticks, maxPositionLots: '1' }) }) }));
  const spec = { id: 'final-campaign', datasetHash: study.datasetHash, planHash: study.planHash, comparisonHash: study.comparisonHash, protocol, maxTrials: 3, finalAuthorityDirectory: join(directory, 'final-authority'), ...options };
  const campaign = createCampaign(join(directory, 'campaign'), spec), sourceRoot = join(directory, 'checkout'), workerModule = join(sourceRoot, 'experiments/final-test/worker.mjs');
  for (const name of [...Object.keys(sourceManifest()), 'build/verification.json']) {
    const target = join(sourceRoot, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repository, name), target);
  }
  cpSync(join(repository, 'node_modules'), join(sourceRoot, 'node_modules'), { recursive: true });
  mkdirSync(dirname(workerModule), { recursive: true });
  const finalFile = join(campaign.spec.finalAuthorityDirectory, 'raw-final.json');
  mkdirSync(dirname(finalFile), { recursive: true }); writeFileSync(finalFile, JSON.stringify(plan.final.map(index => samples[index])));
  writeFileSync(workerModule, `import {readFileSync} from 'node:fs';
  export default async function(configuration,context) {
    if(configuration.fail) throw new Error('training failed');
    try {readFileSync(configuration.finalFile);throw new Error('Exploration worker received final data');}
    catch(error) {if(error.code!=='ERR_ACCESS_DENIED')throw error;}
    context.writeArtifact('model.json', {lots:'1',seed:context.seed});
    return {study:configuration.study,modelArtifact:'model.json',finalReadDenied:true};
  }\n`);
  const job = (key, extra = {}) => ({ key, workerModule, sourceRoot, configuration: { study, finalFile, ...extra } });
  return { directory, campaign, spec, study, job, samples, plan, input: { samples, plan } };
}

async function complete(fixture_) {
  fixture_.campaign.submit(fixture_.job('winner'));
  fixture_.campaign.seal();
  return fixture_.campaign.run({ timeoutMs: 30000 });
}

test('campaign final release derives its winner, protocol and artifact identity from official records', async t => {
  const f = await fixture(t), report = await complete(f);
  const fake = { ...f.campaign, spec: { finalAuthorityDirectory: join(f.directory, 'alternate') }, report: () => ({ selection: { selectedId: 'substitute' } }) };
  const result = await releaseCampaignFinal(fake, f.input, (evaluation, context) => {
    assert.equal(evaluation.partition, 'final');
    assert.deepEqual(evaluation.rows.map(row => row.id), ['q9', 'q10', 'q11']);
    assert.equal(context.selection.trialId, 'winner');
    assert.equal(context.selection.campaignReportHash, report.hash);
    assert.equal(context.selection.studyHash, f.study.hash);
    assert.equal(context.result.finalReadDenied, true, 'The frozen exploration worker could not read hidden final data');
    assert.equal(context.claim.strategyHash, context.selection.strategyHash);
    assert.deepEqual(context.claim.protocol.evaluation, f.spec.protocol);
    assert.deepEqual(context.claim.protocol.selection, context.selection);
    assert.deepEqual(JSON.parse(context.readArtifact(context.result.modelArtifact).toString()), { lots: '1', seed: report.population[0].seed });
    assert.throws(() => context.readArtifact('../outside.json'), { code: 'CAMPAIGN_FINAL_ARTIFACT' });
    assert.throws(() => { context.result.study.aggregate.netPnl = '999'; }, TypeError);
    assert.ok(Object.isFrozen(context.selection.artifactHashes));
    return { selectedId: context.selection.trialId, evaluationHash: evaluation.hash };
  });
  assert.equal(result.selectedId, 'winner');
  const authority = f.campaign.spec.finalAuthorityDirectory;
  assert.equal(readdirSync(authority).filter(name => name.endsWith('.claim.json')).length, 1);
  const recorded = JSON.parse(readFileSync(join(authority, readdirSync(authority).find(name => name.endsWith('.result.json'))), 'utf8'));
  assert.equal(recorded.resultHash, hash(result));
  await assert.rejects(releaseCampaignFinal(f.campaign, f.input, () => null), { code: 'FINAL_TEST_REUSE' });
});

test('final release rejects open, incomplete and invalid populations before exposing data', async t => {
  const f = await fixture(t);
  let called = false;
  const work = () => { called = true; return null; };
  await assert.rejects(releaseCampaignFinal(f.campaign, f.input, work), { code: 'CAMPAIGN_FINAL_PENDING' });
  f.campaign.submit(f.job('winner'));
  f.campaign.seal();
  await assert.rejects(releaseCampaignFinal(f.campaign, f.input, work), { code: 'CAMPAIGN_FINAL_PENDING' });
  const failed = await fixture(t);
  failed.campaign.submit(failed.job('failed', { fail: true })); failed.campaign.seal();
  await failed.campaign.run({ timeoutMs: 30000 });
  await assert.rejects(releaseCampaignFinal(failed.campaign, failed.input, work), { code: 'CAMPAIGN_FINAL_SELECTION' });
  const invalid = await fixture(t);
  invalid.campaign.submit(invalid.job('invalid', { study: { ...invalid.study, hash: hash('invalid') } })); invalid.campaign.seal();
  await invalid.campaign.run({ timeoutMs: 30000 });
  await assert.rejects(releaseCampaignFinal(invalid.campaign, invalid.input, work), { code: 'CAMPAIGN_FINAL_SELECTION' });
  assert.equal(called, false);
});

test('final inputs cannot override authority, winner, protocol or frozen data identities', async t => {
  const f = await fixture(t); await complete(f);
  for (const extra of [{ strategyHash: hash('different') }, { holdoutId: 'new-name' }, { directory: f.directory }, { protocol: {} }, { selectedId: 'different' }]) {
    await assert.rejects(releaseCampaignFinal(f.campaign, { ...f.input, ...extra }, () => null), { code: 'CAMPAIGN_FINAL_INPUT' });
  }
  const samples = structuredClone(f.samples); samples.at(-1).id = 'changed';
  await assert.rejects(releaseCampaignFinal(f.campaign, { samples, plan: f.plan }, () => null), { code: 'CAMPAIGN_FINAL_PLAN' });
  const plan = walkForwardSplits(f.samples, { trainSize: 2, validationSize: 3, finalStart: 9 });
  await assert.rejects(releaseCampaignFinal(f.campaign, { samples: f.samples, plan }, () => null), { code: 'CAMPAIGN_FINAL_PLAN' });
  await releaseCampaignFinal(f.campaign, f.input, () => ({ ok: true }));
});

test('final callback failure consumes the canonical release and persists its failure audit', async t => {
  const f = await fixture(t); await complete(f);
  await assert.rejects(releaseCampaignFinal(f.campaign, f.input, () => { throw new Error('evaluation failed'); }), /evaluation failed/);
  const authority = f.campaign.spec.finalAuthorityDirectory;
  const failure = JSON.parse(readFileSync(join(authority, readdirSync(authority).find(name => name.endsWith('.failure.json'))), 'utf8'));
  assert.equal(failure.status, 'failed'); assert.equal(failure.error, 'evaluation failed');
  await assert.rejects(releaseCampaignFinal(f.campaign, f.input, () => null), { code: 'FINAL_TEST_REUSE' });
});

test('changed selected results or model artifacts cannot reach final evaluation', async t => {
  const f = await fixture(t), report = await complete(f), attempt = report.population[0].attempts.at(-1);
  const artifactPath = join(attempt.outputDirectory, 'model.json'), original = readFileSync(artifactPath);
  writeFileSync(artifactPath, '{"lots":"999"}');
  await assert.rejects(releaseCampaignFinal(f.campaign, f.input, () => null), { code: 'ARTIFACT_CHANGED' });
  writeFileSync(artifactPath, original);
  const resultPath = join(attempt.outputDirectory, '..', 'result.json'), result = readFileSync(resultPath);
  writeFileSync(resultPath, '{}');
  await assert.rejects(releaseCampaignFinal(f.campaign, f.input, () => null), { code: 'RESULT_CHANGED' });
  writeFileSync(resultPath, result);
  await assert.rejects(releaseCampaignFinal(f.campaign, f.input, (evaluation, context) => {
    writeFileSync(artifactPath, '{"lots":"999"}');
    return context.readArtifact('model.json');
  }), { code: 'ARTIFACT_CHANGED' });
  writeFileSync(artifactPath, original);
  await assert.rejects(releaseCampaignFinal(f.campaign, f.input, () => null), { code: 'FINAL_TEST_REUSE' });
});

function child(code, payload) {
  return new Promise((resolveChild, reject) => {
    const process_ = spawn(process.execPath, ['--input-type=module', '-e', code, payload], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process_.stdout.on('data', data => { stdout += data; }); process_.stderr.on('data', data => { stderr += data; });
    process_.once('error', reject);
    process_.once('close', status => status === 0 ? resolveChild(JSON.parse(stdout)) : reject(new Error(`Final release child exited ${status}: ${stderr}`)));
  });
}

test('independent final evaluators contend for one persistent canonical claim', async t => {
  const f = await fixture(t); await complete(f);
  const payload = join(f.directory, 'final-input.json');
  writeFileSync(payload, JSON.stringify({ root: f.campaign.root, input: f.input }));
  const code = `import {readFileSync} from 'node:fs'; import {releaseCampaignFinal} from ${JSON.stringify(new URL('../../src/campaign-final.mjs', import.meta.url).href)};
    const {root,input}=JSON.parse(readFileSync(process.argv[1],'utf8'));
    try {await releaseCampaignFinal({root},input,async()=>{await new Promise(resolve=>setTimeout(resolve,50));return {ok:true};});console.log(JSON.stringify({released:true}));}
    catch(error){if(error.code!=='FINAL_TEST_REUSE')throw error;console.log(JSON.stringify({released:false,code:error.code}));}`;
  const outcomes = await Promise.all([child(code, payload), child(code, payload)]);
  assert.equal(outcomes.filter(row => row.released).length, 1);
  assert.equal(outcomes.filter(row => row.code === 'FINAL_TEST_REUSE').length, 1);
});

test('campaign names and changed training splits cannot rename identical held-out observations', async t => {
  const f = await fixture(t); await complete(f);
  const renamed = createCampaign(join(f.directory, 'renamed-campaign'), { ...f.spec, id: 'renamed' });
  renamed.submit(f.job('renamed-winner')); renamed.seal(); await renamed.run({ timeoutMs: 30000 });
  assert.equal(renamed.spec.finalAuthorityDirectory, f.campaign.spec.finalAuthorityDirectory);
  const differentPlan = await fixture(t, { planOptions: { trainSize: 2 }, finalAuthorityDirectory: f.campaign.spec.finalAuthorityDirectory });
  await complete(differentPlan);
  assert.notEqual(differentPlan.spec.planHash, f.spec.planHash);
  assert.equal(differentPlan.spec.datasetHash, f.spec.datasetHash);
  await releaseCampaignFinal(f.campaign, f.input, () => ({ ok: true }));
  await assert.rejects(releaseCampaignFinal(renamed, f.input, () => null), { code: 'FINAL_TEST_REUSE' });
  await assert.rejects(releaseCampaignFinal(differentPlan.campaign, differentPlan.input, () => null), { code: 'FINAL_TEST_REUSE' });
});
