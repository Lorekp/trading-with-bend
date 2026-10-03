import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { enqueueExperiment, runExperiment, runQueue, readExperimentResult, gridJobs, walkForwardSplits, withFinalHoldout, hash, json } from '../src/index.mjs';
import { evaluateWindow } from '../experiments/derivatives/worker.mjs';

// Deterministic synthetic plumbing exercise. No vendor/exchange calibration claim.
const args = process.argv.slice(2).filter(arg => arg !== '--final');
const root = resolve(args[0] ?? 'output/derivatives-demo');
const payoff = args[1] ?? 'inverse', kind = args[2] ?? 'perpetual';
if (!['linear', 'inverse'].includes(payoff) || !['future', 'perpetual'].includes(kind)) throw new Error('Usage: derivatives.mjs [registry] [linear|inverse] [future|perpetual]');
mkdirSync(root, { recursive: true });
const instrument = { symbol: `SYNTHETIC-${payoff}-${kind}`, currency: payoff === 'inverse' ? 'COIN' : 'USD', lotSize: '1', priceTick: '1' };
const contract = { kind, payoff, contractValue: '1', settlementScale: payoff === 'inverse' ? '1000000' : '1',
  ...(kind === 'perpetual' ? { fundingIntervalMs: '5', fundingOffsetMs: '0' } : { expiryTime: '39' }) };
const config = { instrument, contract, initialCash: '100000', maxPositionLots: '10', initialMarginBps: '1000', maintenanceMarginBps: '500',
  feeBps: '5', liquidationFeeBps: '100', slippageBps: '500', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '2', maxMarkAgeMs: '2' };
const events = [], samples = [];
for (let t = 0; t < 40; t++) {
  const price = String(100 + Math.floor(t / 4));
  const event = (type, fields) => events.push({ id: `event-${events.length}`, type, time: String(t), sourceTime: String(t), sequence: String(events.length + 1), symbol: instrument.symbol, currency: instrument.currency, ...fields });
  event('mark', { price });
  if (kind === 'perpetual' && t % 5 === 0) event('funding', { price, ratePpm: t % 10 === 0 ? '1000' : '-500' });
  event('quote', { bid: price, ask: price, bidLots: '2', askLots: '2' });
  if (kind === 'future' && t === 39) event('settlement', { price });
  samples.push({ id: `sample-${t}`, time: String(t), availableAt: String(t), labelAvailableAt: String(t + 1) });
}
const dataset = { data: { startTime: '0', endTime: '39', events }, samples };
const datasetPath = resolve(root, 'dataset.json');
try { writeFileSync(datasetPath, json(dataset), { flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST' || hash(JSON.parse(readFileSync(datasetPath, 'utf8'))) !== hash(dataset)) throw error; }
const split = { trainSize: 10, validationSize: 10, stepSize: 10, embargoMs: '1', expanding: true, finalStart: 30 };
const workerModule = new URL('../experiments/derivatives/worker.mjs', import.meta.url);
const specs = gridJobs({ namespace: `derivatives-demo/${payoff}/${kind}/v1`, workerModule,
  baseConfiguration: { datasetPath, config, split, datasetSeed: '0' }, space: { targetLots: ['-2', '0', '2'] }, dependencies: [datasetPath] });
for (const spec of specs) enqueueExperiment(root, spec);
const keys = new Set(specs.map(spec => spec.key));
const jobs = (await runQueue(root, { concurrency: 2, timeoutMs: 30000 })).filter(job => keys.has(job.key));
const trials = jobs.map(job => ({ id: job.key, status: job.status,
  result: job.status === 'completed' ? readExperimentResult(root, job.key) : null, error: job.attempts.at(-1)?.error ?? null }));
// Keep every failed attempt in output; choose only by validation, within one currency/model.
const completed = trials.filter(trial => trial.result).sort((a, b) => {
  const delta = BigInt(b.result.validationPnl) - BigInt(a.result.validationPnl);
  return delta === 0n ? a.id.localeCompare(b.id) : delta > 0n ? 1 : -1;
});
if (!completed.length) throw new Error(`No completed trials: ${json(trials)}`);
let final = null;
if (process.argv.includes('--final')) {
  const selected = completed[0], plan = walkForwardSplits(samples, split);
  const protocol = { selectedTrial: selected.id, score: 'sum-validation-net-pnl', configHash: hash(config), datasetHash: hash(dataset) };
  final = await withFinalHoldout(resolve(root, 'holdout'), { holdoutId: 'derivatives-demo-v1', strategyHash: hash({ targetLots: selected.result.targetLots, protocol }), protocol, samples, plan }, rows =>
    runExperiment(root, { protocol, targetLots: selected.result.targetLots, evaluationPartition: 'final' }, (_, context) => {
      const report = evaluateWindow({ config, data: dataset.data, rows, targetLots: selected.result.targetLots });
      context.writeArtifact('report.json', report);
      return report;
    }).result);
}
console.log(json({ registry: root, trials, selected: completed[0].id, final }));
if (jobs.some(job => job.status !== 'completed')) process.exitCode = 1;
