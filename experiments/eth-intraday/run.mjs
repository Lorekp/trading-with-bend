import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCampaign, enqueueExperiment, hash, listExperiments, readExperimentResult,
  runQueue, verifyExperimentArtifacts,
} from '../../src/index.mjs';
import { requireThat } from '../../src/core.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const root = resolve(process.argv[2] ?? 'output/eth-intraday-20261003-v1');
const datasetPath = resolve(process.argv[3] ?? 'output/eth-intraday-inputs/dataset.json');
const preflightOnly = process.argv.includes('--preflight-only');
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
const { datasetHash, ...body } = dataset;
requireThat(datasetHash === hash(body), 'STUDY_DATA', 'Prepared input identity changed');
mkdirSync(root, { recursive: true });

function persist(name, value) {
  const path = join(root, name);
  try { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    requireThat(hash(JSON.parse(readFileSync(path, 'utf8'))) === hash(value), 'STUDY_COLLISION', `Existing ${name} differs; use a new study identity`);
  }
}
const skillFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? skillFiles(path) : [path];
});
const skills = readdirSync(join(repository, 'skills')).filter(name => name.startsWith('bend-')).flatMap(name => skillFiles(join(repository, 'skills', name)));
const parameters = [];
for (const family of ['continuation', 'reversal']) for (const lookbackMinutes of [30, 60, 120]) for (const thresholdBps of [0, 10]) {
  parameters.push({ family, lookbackMinutes, thresholdBps, targetLots: '1000', maxHoldingMinutes: 60, cooldownMinutes: 15 });
}
const key = value => `${value.family}/lookback-${value.lookbackMinutes}/threshold-${value.thresholdBps}`;
const resourceBudget = { workers: 2, cpuThreads: 2, memoryMiB: 2048 };
const options = { concurrency: 2, resourceBudget, admissionRoot: join(root, 'admission'), timeoutMs: 600000,
  maxLogBytes: 1024 * 1024, maxArtifactBytes: 256 * 1024 * 1024, maxResultBytes: 32 * 1024 * 1024 };
const protocol = { warmup: 'history-only', account: 'reset-per-fold', intervalMs: '60000', periodsPerYear: 525600, maxStalenessMs: '120000' };
const split = { trainSize: dataset.samples.length - 3 * 2880, validationSize: 2880, stepSize: 2880,
  embargoMs: '0', expanding: false, finalStart: dataset.samples.length };
requireThat(split.trainSize >= 121, 'STUDY_WINDOW', 'Three two-day folds need sufficient preceding history');
const scenarios = { base: {}, stress: { feeBps: '10', orderLatencyMs: '120000', cancelLatencyMs: '60000' } };
const researchPlan = {
  schema: 'eth-intraday-research-plan-v1', id: basename(root), discoveryStatus: 'exploratory-development',
  implementationBase: 'e9bdb63', datasetHash, window: dataset.provenance.window, split, protocol,
  thesis: 'Compare ETH intraday continuation and reversal on completed Binance information with independent OKX execution inputs',
  alternative: 'Apparent performance reflects directional exposure, selected noise or optimistic bar fill assumptions',
  parameters, scenarios, resourceBudget,
  budget: { diagnosticJobs: 2, baseCandidates: 12, stressCandidates: 6, maximumTotalAdmissions: 20, recovery: 'Explicit dead-owner recovery only; retain every attempt' },
  stressSelection: 'After sealed base completion, stress the six highest-return valid base candidates, ties by lexical ID; this is adaptive exploration, not confirmation',
  capital: '10000 USDT per reset account', maximumTarget: '1000 lots = 1 ETH, fully collateralized initial margin',
  holding: 'Request exit after 60 minutes from first observed fill; actual exposure may last longer through cancellation/liquidity delays',
  cooldown: '15 minutes from first observed flat account with no working order', terminalExit: 'Request flat five minutes before fold end for every noncash variant',
  controls: ['cash', 'hold one ETH', 'short one ETH'],
  costs: 'Base fee 5 bps per fill, stress 10 bps; assumptions, not a verified account fee tier. Spread and participation are fixed in input provenance. SlippageBps is a limit collar, not an extra P&L debit.',
  acceptance: { positiveAggregateNetPnl: true, beatsEveryBaseControl: true, minimumPositiveFolds: 2,
    maximumFoldDrawdownBpsOfInitialCapital: 500, noLiquidations: true, noTerminalExposure: true,
    sameWinnerPositiveUnderStress: true, completePopulation: true },
  selection: 'Official aggregate-validation-return; acceptance may reject that winner and never substitutes another',
  uncertainty: 'Seven development days cannot establish a selection-adjusted edge; retain aligned equity and all attempts for later dependence-aware inference. No confidence/profitability claim.',
  falsifiers: ['No net improvement over controls', 'Profit disappears with declared cost/delay stress', 'Drawdown, liquidation or terminal exposure breaches acceptance'],
  priorExposure: 'September was used in earlier development; earlier searches exist and their complete count is unknown',
  final: 'No final partition and no final release; new untouched evidence required for confirmation',
  skillHashes: Object.fromEntries(skills.map(path => [path.slice(repository.length).replaceAll('\\', '/'), hash(readFileSync(path, 'utf8'))])),
};
persist('research-plan.json', researchPlan);
const workerModule = join(repository, 'experiments/eth-intraday/worker.mjs');
const dependencies = [join(repository, 'experiments/eth-intraday/run.mjs'), join(repository, 'experiments/eth-intraday/prepare-data.mjs'), ...skills];
const job = (name, value, scenario) => ({ key: name, workerModule, dependencies, seed: 20261003,
  resources: { cpuThreads: 1, memoryMiB: 1024 }, inputFiles: { '/datasetPath': datasetPath },
  configuration: { datasetPath, datasetHash, split, protocol, parameters: value, executionOverrides: scenarios[scenario], researchPlan } });

// The preflights are registered cash diagnostics, never unrecorded candidate trials.
const diagnosticRoot = join(root, 'diagnostics');
for (const scenario of Object.keys(scenarios)) enqueueExperiment(diagnosticRoot,
  { ...job(`preflight/${scenario}`, { ...parameters[0], family: 'cash' }, scenario), frozen: true, constrained: true });
console.log(JSON.stringify({ phase: 'registered-preflights', root, count: 2 }));
await runQueue(diagnosticRoot, options);
const diagnostics = listExperiments(diagnosticRoot);
persist('diagnostics.json', diagnostics);
requireThat(diagnostics.every(trial => trial.status === 'completed'), 'STUDY_PREFLIGHT', 'Inspect registered failed diagnostics before creating a fresh corrected study');
const preflights = Object.fromEntries(Object.keys(scenarios).map(scenario => [scenario, readExperimentResult(diagnosticRoot, `preflight/${scenario}`).study]));
console.log(JSON.stringify({ phase: 'preflights-complete', folds: preflights.base.folds.length }));
if (preflightOnly) process.exit(0);

function campaignFor(scenario, count) {
  const study = preflights[scenario];
  return createCampaign(join(root, scenario), { id: `${researchPlan.id}/${scenario}`, datasetHash: study.datasetHash,
    planHash: study.planHash, comparisonHash: study.comparisonHash, protocol, maxTrials: count,
    resourceBudget, finalAuthorityDirectory: resolve(repository, 'output/shared-final-authority'), workerIsolation: 'filesystem' });
}
const base = campaignFor('base', parameters.length);
for (const value of parameters) base.submit(job(key(value), value, 'base'));
base.seal();
console.log(JSON.stringify({ phase: 'base-started', count: parameters.length, root: base.root }));
const baseReport = await base.run(options);
const ranked = baseReport.selection.population.filter(trial => trial.valid).sort((a, b) => {
  const difference = BigInt(b.totalReturn.numerator) * BigInt(a.totalReturn.denominator) - BigInt(a.totalReturn.numerator) * BigInt(b.totalReturn.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : a.id.localeCompare(b.id);
}).slice(0, 6);
let stressReport = null, stress = null;
if (ranked.length) {
  persist('stress-admission.json', { rule: researchPlan.stressSelection, baseReportHash: baseReport.hash, ids: ranked.map(trial => trial.id) });
  stress = campaignFor('stress', ranked.length);
  for (const trial of ranked) stress.submit(job(trial.id, parameters.find(value => key(value) === trial.id), 'stress'));
  stress.seal();
  console.log(JSON.stringify({ phase: 'stress-started', count: ranked.length, root: stress.root }));
  stressReport = await stress.run(options);
}

function population(campaign, report) {
  if (!report) return [];
  return report.population.map(trial => {
    if (trial.status !== 'completed') return { id: trial.id, status: trial.status, error: trial.error };
    verifyExperimentArtifacts(campaign.registryRoot, trial.id);
    const { study } = readExperimentResult(campaign.registryRoot, trial.id);
    return { id: trial.id, status: trial.status, netPnlMicroUsdt: study.aggregate.netPnl, feesMicroUsdt: study.aggregate.fees,
      totalReturn: study.aggregate.totalReturn, baselineExcessReturns: Object.fromEntries(Object.entries(study.baselines).map(([name, baseline]) => [name, baseline.excessReturn])),
      folds: study.folds.map(fold => ({ id: fold.id, netPnlMicroUsdt: fold.candidate.report.performance.netPnl,
        maxDrawdownMicroUsdt: fold.candidate.report.performance.maxDrawdown,
        liquidations: fold.candidate.report.performance.liquidations, terminalQuantity: fold.candidate.report.terminal.ledger.quantity,
        fundingMicroUsdt: fold.candidate.report.performance.funding })) };
  });
}
const basePopulation = population(base, baseReport), stressPopulation = population(stress, stressReport);
const winner = basePopulation.find(trial => trial.id === baseReport.selection.selectedId);
const stressWinner = stressPopulation.find(trial => trial.id === winner?.id);
const acceptance = {
  completePopulation: [...basePopulation, ...stressPopulation].every(trial => trial.status === 'completed'),
  positiveNetPnl: winner ? BigInt(winner.netPnlMicroUsdt) > 0n : false,
  beatsEveryBaseControl: winner ? Object.values(winner.baselineExcessReturns).every(value => BigInt(value.numerator) > 0n) : false,
  positiveFolds: winner ? winner.folds.filter(fold => BigInt(fold.netPnlMicroUsdt) > 0n).length >= 2 : false,
  boundedDrawdown: winner && stressWinner?.status === 'completed'
    ? [...winner.folds, ...stressWinner.folds].every(fold => BigInt(fold.maxDrawdownMicroUsdt) * 10000n <= BigInt(dataset.config.initialCash) * 500n) : false,
  noLiquidationsOrTerminalExposure: winner ? winner.folds.every(fold => fold.liquidations === 0 && BigInt(fold.terminalQuantity) === 0n) : false,
  survivesStress: stressWinner?.status === 'completed' ? BigInt(stressWinner.netPnlMicroUsdt) > 0n
    && stressWinner.folds.every(fold => fold.liquidations === 0 && BigInt(fold.terminalQuantity) === 0n) : false,
};
const summary = { study: researchPlan.id, datasetHash, baseReportHash: baseReport.hash, stressReportHash: stressReport?.hash ?? null,
  totalAdmissions: diagnostics.length + basePopulation.length + stressPopulation.length,
  officialBaseWinner: winner?.id ?? null, acceptance,
  decision: Object.values(acceptance).every(Boolean) ? 'candidate-for-longer-exploration' : 'no-acceptable-strategy',
  evidence: 'Exploratory seven-day bar execution proxy; no final evaluation, selection-adjusted significance or calibrated execution claim',
  basePopulation, stressPopulation };
persist('summary.json', summary);
console.log(JSON.stringify({ phase: 'complete', root, summary: join(root, 'summary.json'), decision: summary.decision,
  winner: summary.officialBaseWinner, admissions: summary.totalAdmissions }));
