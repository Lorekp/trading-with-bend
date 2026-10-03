import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCampaign } from './campaigns.mjs';
import { freeze, hash, requireThat } from './core.mjs';
import { walkForwardSplits, withFinalHoldout } from './evaluation.mjs';
import { readExperimentResult, verifyExperimentArtifacts } from './experiments.mjs';

/** Release the official selected result once through the campaign-owned authority.
 * The trusted parent supplies final data; exploration workers never receive it.
 * Campaigns sharing data must share finalAuthorityDirectory, including across
 * checkouts. This is a cooperative research gate, not a sandbox for this callback.
 * Failed callbacks consume the release. Artifact reads return verified bytes.
 */
export async function releaseCampaignFinal(campaign, input, work) {
  requireThat(campaign && typeof campaign.root === 'string' && input && Object.keys(input).every(key => ['samples', 'plan'].includes(key)) && typeof work === 'function',
    'CAMPAIGN_FINAL_INPUT', 'Supply a campaign, final samples and plan, and a trusted final callback');
  // Reopen from persistent records rather than trusting a caller's report,
  // methods, selected trial or replacement authority directory.
  const root = resolve(campaign.root);
  const { format, specificationHash, ...specification } = JSON.parse(readFileSync(join(root, 'campaign.json'), 'utf8'));
  requireThat(format === 'campaign-v1', 'CAMPAIGN_CORRUPT', 'Invalid persistent campaign specification');
  const official = createCampaign(root, specification);
  requireThat(official.spec.specificationHash === specificationHash, 'CAMPAIGN_CORRUPT', 'Persistent campaign specification hash changed');
  const report = official.report();
  requireThat(report.sealed && report.complete, 'CAMPAIGN_FINAL_PENDING', 'Seal and finish every registered trial before final release');
  const selectedId = report.selection?.selectedId;
  const selected = report.selection?.population.find(trial => trial.id === selectedId);
  requireThat(selectedId && selected?.valid, 'CAMPAIGN_FINAL_SELECTION', 'A complete verified validation winner is required');

  // Admit copies before any asynchronous callback can mutate caller-owned data.
  const samples = freeze(structuredClone(input.samples)), plan = freeze(structuredClone(input.plan));
  requireThat(Array.isArray(samples) && plan && hash(samples) === official.spec.datasetHash && plan.datasetHash === official.spec.datasetHash && hash(plan) === official.spec.planHash &&
    hash(walkForwardSplits(samples, plan.options)) === official.spec.planHash && plan.final.length > 0,
  'CAMPAIGN_FINAL_PLAN', 'Final data and split plan must match the frozen campaign');
  const trial = report.population.find(row => row.id === selectedId), attempt = trial.attempts.at(-1);
  const result = freeze(readExperimentResult(official.registryRoot, selectedId));
  const study = result.format === 'validation-study-v1' ? result : result.study;
  requireThat(attempt?.status === 'completed' && study.hash === selected.studyHash, 'CAMPAIGN_FINAL_SELECTION', 'Selected immutable result does not match the official selection');
  const identity = {
    trialId: selectedId, jobSpecificationHash: trial.specificationHash, configurationHash: trial.configurationHash,
    resultHash: attempt.resultHash, studyHash: study.hash, artifactHashes: attempt.artifactHashes,
  };
  const selection = freeze({ ...identity, strategyHash: hash(identity), campaignHash: official.spec.specificationHash, campaignReportHash: report.hash });
  // The partition's rows define its identity. Changing campaign names, training
  // windows or other split options cannot rename the same final observations.
  const holdoutId = hash({ format: 'campaign-final-partition-v1', datasetHash: official.spec.datasetHash, finalRows: plan.final.map(index => samples[index]) });
  const protocol = freeze({ evaluation: official.spec.protocol, selection });
  const readArtifact = name => {
    requireThat(typeof name === 'string' && Object.hasOwn(selection.artifactHashes, name), 'CAMPAIGN_FINAL_ARTIFACT', 'Read only a selected, recorded artifact');
    verifyExperimentArtifacts(official.registryRoot, selectedId);
    const bytes = readFileSync(join(attempt.outputDirectory, name));
    requireThat(createHash('sha256').update(bytes).digest('hex') === selection.artifactHashes[name], 'ARTIFACT_CHANGED', 'Selected artifact changed after verification');
    return bytes;
  };
  return withFinalHoldout(official.spec.finalAuthorityDirectory, {
    holdoutId, strategyHash: selection.strategyHash, protocol, samples, plan,
  }, (evaluation, claim) => work(evaluation, freeze({ selection, result, claim, readArtifact })));
}
