import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freemem, tmpdir, totalmem } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createCampaign, cancelExperiment, evaluateStudy, listExperiments, queueStatus, readExperimentResult, recoverExperiment, recoverQueue, releaseCampaignFinal, walkForwardSplits, QuoteExecutionVenue, quoteInformationSource, targetPosition } from '../../src/index.mjs';
import { sourceManifest } from '../../src/provenance.mjs';

const api = new URL('../../src/index.mjs', import.meta.url).href;
const repository = fileURLToPath(new URL('../../', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function eventually(check, timeout = 30000) {
  const started = Date.now();
  while (!check()) { assert.ok(Date.now() - started < timeout, 'Timed out waiting for a real swarm process transition'); await delay(25); }
}

function launch(code, args = []) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
  return { child, done };
}

test('a profiled local swarm keeps one complete population under independent submitters, runners and final authority', { timeout: 240000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bend-swarm-')), sourceRoot = join(directory, 'checkout'), root = join(directory, 'campaign');
  const children = [], workerPids = new Set();
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    for (const pid of workerPids) if (alive(pid)) { try { process.kill(pid); } catch {} }
    await Promise.all(children.map(process_ => process_.done));
    rmSync(directory, { recursive: true, force: true });
  });
  const instrument = { symbol: 'SWARM', currency: 'EUR', lotSize: '1', priceTick: '1' };
  const ticks = Array.from({ length: 12 }, (_, index) => ({ id: `q${index}`, type: 'tick', time: String(index * 10), sourceTime: String(index * 10), sequence: String(index + 1), symbol: instrument.symbol, currency: instrument.currency, bid: String(100 + index), ask: String(101 + index), bidLots: '10', askLots: '10' }));
  const samples = ticks.map(row => ({ id: row.id, time: row.time, labelAvailableAt: String(BigInt(row.time) + 1n) }));
  const plan = walkForwardSplits(samples, { trainSize: 3, validationSize: 3, finalStart: 9 });
  const protocol = { warmup: 'history-only', account: 'reset-per-fold', intervalMs: '10', periodsPerYear: 252, maxStalenessMs: '0' };
  const configuration = { instrument, initialCash: '1000', feePerLot: '0', orderLatencyMs: '1', cancelLatencyMs: '0', maxQuoteAgeMs: '10', manifest: { datasetVersion: 'swarm-fixture', strategyArtifact: 'target-one', evaluationProtocol: 'validation', seed: '1' } };
  const study = await evaluateStudy({ samples, plan, protocol }, () => ({ strategy: targetPosition('1'), baselines: { cash: targetPosition('0') }, createReplay: () => ({ informationSource: quoteInformationSource({ id: 'swarm-information', instrument, ticks }), executionVenue: new QuoteExecutionVenue({ id: 'swarm-venue', config: configuration, ticks, maxPositionLots: '1' }) }) }));
  for (const name of [...Object.keys(sourceManifest()), 'build/verification.json']) {
    const target = join(sourceRoot, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repository, name), target);
  }
  cpSync(join(repository, 'node_modules'), join(sourceRoot, 'node_modules'), { recursive: true });
  const workerModule = join(sourceRoot, 'experiments/swarm/worker.mjs'), input = join(directory, 'validation.json');
  const finalAuthorityDirectory = join(directory, 'final-authority'), hidden = join(finalAuthorityDirectory, 'final.json');
  mkdirSync(dirname(workerModule), { recursive: true }); mkdirSync(finalAuthorityDirectory);
  writeFileSync(hidden, JSON.stringify(plan.final.map(index => samples[index])));
  writeFileSync(input, JSON.stringify({ marker: 'validation-v1', study }));
  writeFileSync(workerModule, `import {readFileSync} from 'node:fs';
    export default async function(configuration,context) {
      context.reportProgress({stage:'validation'});
      if(configuration.hangOnFirst && context.previousAttempts.length===0) await new Promise(()=>setInterval(()=>context.heartbeat(),100));
      const input=JSON.parse(readFileSync(configuration.input,'utf8'));
      let denied;try{readFileSync(configuration.hidden,'utf8');denied='readable';}catch(error){denied=error.code;}
      await new Promise(resolve=>setTimeout(resolve,configuration.delay??800));
      if(configuration.fail)throw new Error('deliberate training failure');
      context.writeArtifact('model.json',{target:'1',marker:input.marker});
      return {study:input.study,marker:input.marker,denied,rssBytes:context.heartbeat().rssBytes};
    }\n`);
  const spec = { id: 'swarm-acceptance', datasetHash: study.datasetHash, planHash: study.planHash, comparisonHash: study.comparisonHash, protocol, maxTrials: 34, resourceBudget: { workers: 2, cpuThreads: 2, memoryMiB: 256 }, finalAuthorityDirectory };
  const campaign = createCampaign(root, spec), admissionRoot = join(directory, 'global-admission'), metrics = join(directory, 'metrics');
  mkdirSync(metrics);
  const job = (key, extra = {}) => ({ key, sourceRoot, workerModule, resources: { cpuThreads: 1, memoryMiB: 128 }, configuration: { input, hidden, ...extra }, inputFiles: { '/input': input } });
  const payload = join(directory, 'submission.json');
  writeFileSync(payload, JSON.stringify({ root, spec, job: job('template'), admissionRoot, metrics }));
  const start = performance.now();
  const profile = { trials: 34, parentPeakRssBytes: 0, supervisorPeakRssBytes: 0, submitterPeakRssBytes: 0, workerPeakRssBytes: 0, peakObservedCombinedRssBytes: 0, hostUsedMemoryPeakBytes: 0, peakReserved: { workers: 0, cpuThreads: 0, memoryMiB: 0 }, samples: 0, measurement: '150 ms RSS samples of parent and live submitters/runners/workers; host used memory includes unrelated processes; sampled values are not OS peak RSS' };
  const violations = [];
  let samplingError;
  const sample = () => {
    try {
      const status = queueStatus(campaign.registryRoot, { admissionRoot }), parentRss = process.memoryUsage().rss;
      profile.parentPeakRssBytes = Math.max(profile.parentPeakRssBytes, parentRss);
      profile.hostUsedMemoryPeakBytes = Math.max(profile.hostUsedMemoryPeakBytes, totalmem() - freemem());
      for (const name of ['workers', 'cpuThreads', 'memoryMiB']) {
        profile.peakReserved[name] = Math.max(profile.peakReserved[name], status.reserved[name]);
        if (status.reserved[name] > spec.resourceBudget[name]) violations.push({ name, actual: status.reserved[name] });
      }
      let supervisorRss = 0, workerRss = 0;
      for (const file of readdirSync(metrics).filter(name => name.endsWith('.json'))) {
        const telemetry = JSON.parse(readFileSync(join(metrics, file), 'utf8'));
        const field = telemetry.role === 'submitter' ? 'submitterPeakRssBytes' : 'supervisorPeakRssBytes';
        profile[field] = Math.max(profile[field], telemetry.peakRssBytes);
        if (alive(telemetry.pid)) supervisorRss += telemetry.rssBytes;
      }
      for (const reservation of status.reservations) {
        const manifest = listExperiments(reservation.registry).find(row => row.key === reservation.key);
        const attempt = manifest?.attempts.find(row => row.token === reservation.attemptToken);
        if (!attempt) continue;
        workerPids.add(attempt.workerPid);
        try {
          const telemetry = JSON.parse(readFileSync(join(dirname(attempt.outputDirectory), 'telemetry.json'), 'utf8'));
          profile.workerPeakRssBytes = Math.max(profile.workerPeakRssBytes, telemetry.rssBytes);
          if (alive(telemetry.pid)) workerRss += telemetry.rssBytes;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      profile.peakObservedCombinedRssBytes = Math.max(profile.peakObservedCombinedRssBytes, parentRss + supervisorRss + workerRss); profile.samples++;
    } catch (error) { samplingError ??= error; }
  };
  const monitor = setInterval(sample, 150); t.after(() => clearInterval(monitor));
  const runCode = `import {readFileSync,writeFileSync,renameSync} from 'node:fs';import {join} from 'node:path';import {runQueue} from ${JSON.stringify(api)};
    const input=JSON.parse(readFileSync(process.argv[1],'utf8'));let peakRssBytes=0;
    const metric=()=>{const rssBytes=process.memoryUsage().rss;peakRssBytes=Math.max(peakRssBytes,rssBytes);const target=join(input.metrics,process.pid+'.json');writeFileSync(target+'.tmp',JSON.stringify({pid:process.pid,role:'runner',rssBytes,peakRssBytes}));renameSync(target+'.tmp',target);};
    metric();const timer=setInterval(metric,100);
    try{await runQueue(join(input.root,'experiments'),{admissionRoot:input.admissionRoot,resourceBudget:input.spec.resourceBudget,concurrency:4,pollMs:50,idleMs:2500,timeoutMs:60000,keyPrefix:process.argv[2]??'',maxLogBytes:65536,maxArtifactBytes:1048576,maxResultBytes:1048576});}
    finally{clearInterval(timer);metric();}console.log(JSON.stringify({done:true}));`;

  campaign.submit(job('interrupted', { hangOnFirst: true }));
  const interrupted = launch(runCode, [payload, 'interrupted']); children.push(interrupted);
  await eventually(() => listExperiments(campaign.registryRoot)[0]?.status === 'running');
  const crashedWorker = listExperiments(campaign.registryRoot)[0].attempts[0].workerPid; workerPids.add(crashedWorker);
  interrupted.child.kill(); await interrupted.done;
  if (alive(crashedWorker)) process.kill(crashedWorker);
  await eventually(() => !alive(crashedWorker));
  assert.equal(queueStatus(campaign.registryRoot, { admissionRoot }).reserved.workers, 1);
  recoverQueue(campaign.registryRoot, { admissionRoot });
  recoverExperiment(campaign.registryRoot, 'interrupted');
  assert.equal(queueStatus(campaign.registryRoot, { admissionRoot }).reserved.workers, 0);
  campaign.submit(job('cancelled')); cancelExperiment(campaign.registryRoot, 'cancelled', 'Operator rejects this trial');
  campaign.submit(job('initial'));
  const runners = [launch(runCode, [payload]), launch(runCode, [payload])]; children.push(...runners);
  await eventually(() => queueStatus(campaign.registryRoot, { admissionRoot }).reserved.workers > 0);
  const submitCode = `import {readFileSync,writeFileSync,renameSync} from 'node:fs';import {join} from 'node:path';import {createCampaign} from ${JSON.stringify(api)};
    const {root,spec,job,metrics}=JSON.parse(readFileSync(process.argv[1],'utf8'));const campaign=createCampaign(root,spec),offset=Number(process.argv[2]);let peakRssBytes=0;
    const metric=()=>{const rssBytes=process.memoryUsage().rss;peakRssBytes=Math.max(peakRssBytes,rssBytes);const target=join(metrics,process.pid+'.json');writeFileSync(target+'.tmp',JSON.stringify({pid:process.pid,role:'submitter',rssBytes,peakRssBytes}));renameSync(target+'.tmp',target);};metric();
    for(let i=offset;i<offset+15;i++){campaign.submit({...job,key:'trial-'+String(i).padStart(2,'0'),configuration:{...job.configuration,fail:i===0}});metric();}
    console.log(JSON.stringify({submitted:15}));`;
  const submitters = [launch(submitCode, [payload, '0']), launch(submitCode, [payload, '15'])]; children.push(...submitters);
  for (const submitter of submitters) { const result = await submitter.done; assert.equal(result.status, 0, result.stderr); }
  campaign.submit(job('frozen-last'));
  writeFileSync(workerModule, 'export default()=>{throw new Error("edited worker executed");};\n');
  writeFileSync(input, 'original input was edited');
  const sealed = campaign.seal();
  assert.equal(sealed.population.length, 34);
  assert.equal(sealed.selection, null, 'Newly admitted final worker keeps official selection pending');
  for (const runner of runners) { const result = await runner.done; assert.equal(result.status, 0, result.stderr); }
  // A runner may drain just before the final arrival; the deep campaign module
  // resumes the same frozen queue rather than requiring caller reconciliation.
  const official = await campaign.run({ admissionRoot, concurrency: 4, timeoutMs: 60000, maxLogBytes: 65536, maxArtifactBytes: 1048576, maxResultBytes: 1048576 });
  clearInterval(monitor); sample();
  assert.ifError(samplingError); assert.deepEqual(violations, []);
  assert.equal(official.complete, true); assert.equal(official.population.length, 34);
  assert.equal(official.selection.population.length, 34);
  assert.equal(official.population.find(row => row.id === 'cancelled').status, 'cancelled');
  assert.equal(official.population.find(row => row.id === 'trial-00').status, 'failed');
  assert.deepEqual(official.population.find(row => row.id === 'interrupted').attempts.map(row => row.status), ['abandoned', 'completed']);
  for (const trial of official.population.filter(row => row.status === 'completed')) {
    const result = readExperimentResult(campaign.registryRoot, trial.id);
    assert.equal(result.marker, 'validation-v1'); assert.equal(result.denied, 'ERR_ACCESS_DENIED');
    profile.workerPeakRssBytes = Math.max(profile.workerPeakRssBytes, result.rssBytes);
  }
  const final = await releaseCampaignFinal(campaign, { samples, plan }, (evaluation, { readArtifact }) => ({ rows: evaluation.rows.length, model: JSON.parse(readArtifact('model.json').toString('utf8')) }));
  assert.equal(final.rows, plan.final.length); assert.equal(final.model.marker, 'validation-v1');
  await assert.rejects(releaseCampaignFinal(campaign, { samples, plan }, () => null), { code: 'FINAL_TEST_REUSE' });
  profile.elapsedMs = Math.round(performance.now() - start);
  profile.membershipEvents = readdirSync(join(root, 'membership')).filter(name => name.endsWith('.json')).length;
  profile.membershipBytes = readdirSync(join(root, 'membership')).filter(name => name.endsWith('.json')).reduce((sum, name) => sum + statSync(join(root, 'membership', name)).size, 0);
  assert.equal(profile.membershipEvents, 70, 'Each trial has one reservation and registration; creation and sealing are single events');
  assert.ok(profile.samples > 0 && profile.workerPeakRssBytes > 0 && profile.supervisorPeakRssBytes > 0);
  t.diagnostic(`SWARM_PROFILE ${JSON.stringify(profile)}`);
  if (process.env.SWARM_PROFILE_PATH) { mkdirSync(dirname(process.env.SWARM_PROFILE_PATH), { recursive: true }); writeFileSync(process.env.SWARM_PROFILE_PATH, JSON.stringify(profile, null, 2) + '\n'); }
});
