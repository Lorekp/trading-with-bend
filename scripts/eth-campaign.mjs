import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { enqueueExperiment, runQueue, readExperimentResult, verifyExperimentArtifacts } from '../src/experiments.mjs';

const root = resolve(process.argv[2] || `output/eth-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
const manifestPath = resolve(process.argv[3] || 'data/binance/um/ETHUSDT/2026-09/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const dataset = manifest.datasets.find(dataset => dataset.type === 'klines');
if (dataset?.status !== 'complete' || !dataset.files?.length) throw new Error('ETH campaign requires complete verified klines in the download manifest');
const dependencies = [manifestPath];
for (const file of dataset.files) {
  // The ingestion adapter resolves and verifies these again in each isolated worker.
  if (file.status !== 'verified' || typeof file.path !== 'string') throw new Error('Every klines archive must be verified and have a path');
  const archive = isAbsolute(file.path) ? file.path : resolve(dirname(manifestPath), file.path);
  dependencies.push(archive, `${archive}.CHECKSUM`);
}
const workerModule = new URL('../experiments/eth/worker.mjs', import.meta.url);
const studies = [
  { name: 'hold', strategy: { type: 'hold', quantity: '1000' } },
  { name: 'ma-cross', strategy: { type: 'ma-cross', quantity: '1000', fast: 12, slow: 48 } },
  { name: 'volatility-breakout', strategy: { type: 'volatility-breakout', quantity: '1000', entryWindow: 24, exitWindow: 12, trendWindow: 96, atrWindow: 14, riskBps: '50', cooldownBars: 3 } },
  { name: 'ridge-alpha-01', strategy: { type: 'walkforward-ridge', quantity: '1000', trainingWindow: 288, minTrain: 96, retrainEvery: 48, alpha: 0.1 } },
  { name: 'ridge-alpha-10', strategy: { type: 'walkforward-ridge', quantity: '1000', trainingWindow: 288, minTrain: 96, retrainEvery: 48, alpha: 10 } },
  { name: 'ma-cross-stress', strategy: { type: 'ma-cross', quantity: '1000', fast: 12, slow: 48 }, feePerLot: '3000', execution: { halfSpreadBps: '10', participationBps: '1' } }
];
for (const { name, ...study } of studies) enqueueExperiment(root, { key: `eth-system-verification/${name}`, workerModule, dependencies,
  configuration: { manifestPath, intervalMinutes: 5, ...study } });
console.log(JSON.stringify({ registry: root, jobs: studies.length, concurrency: 2, status: 'running' }));
const jobs = await runQueue(root, { concurrency: 2, timeoutMs: 300000 });
const trials = jobs.map(job => {
  if (job.status !== 'completed') return { key: job.key, status: job.status, error: job.attempts.at(-1)?.error ?? null };
  verifyExperimentArtifacts(root, job.key);
  const result = readExperimentResult(root, job.key);
  const { status: reportStatus, ...rest } = result;
  return { key: job.key, status: job.status, reportStatus, ...rest };
});
const hashes = trials.filter(trial => trial.status === 'completed').map(trial => trial.dataHash);
const summary = { registry: root, scope: 'Development system verification, all trials retained; no best-strategy selection or final holdout claim',
  sourceMarket: manifest.market, missingBookTicker: manifest.datasets.find(dataset => dataset.type === 'bookTicker')?.status !== 'complete',
  sameDataAcrossCompletedTrials: hashes.length > 0 && new Set(hashes).size === 1, trials };
mkdirSync(root, { recursive: true });
const summaryPath = resolve(root, `summary-${randomUUID()}.json`);
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ summary: summaryPath, ...summary }, null, 2));
if (jobs.some(job => job.status !== 'completed')) process.exitCode = 1;
