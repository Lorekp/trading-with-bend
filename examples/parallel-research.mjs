import { resolve } from 'node:path';
import { enqueueExperiment, runQueue, readExperimentResult } from '../src/experiments.mjs';
import { gridJobs } from '../src/search.mjs';
import { comparisonTable } from '../src/evaluation.mjs';

const root = resolve(process.argv[2] || 'output/research-demo');
const workerModule = new URL('./research-worker.mjs', import.meta.url);
const groups = [
  { kind: 'hold', space: {} },
  { kind: 'crossover', space: { fast: [2, 4], slow: [10] } },
  { kind: 'reversion', space: { window: [5], entryBps: ['50'] } },
  { kind: 'ridge', space: { alpha: [0.1, 10], threshold: [0] } }
];
for (const { kind, space } of groups) for (const job of gridJobs({ namespace: `shared-demo/${kind}`, workerModule, baseConfiguration: { kind, datasetSeed: '41' }, space })) enqueueExperiment(root, job);
const jobs = await runQueue(root, { concurrency: 3, timeoutMs: 30000 });
const table = comparisonTable(jobs.map(job => ({ id: job.key, status: job.status, report: job.status === 'completed' ? readExperimentResult(root, job.key).report : null, error: job.attempts.at(-1)?.error })));
console.log(JSON.stringify({ registry: root, trials: table }, null, 2));
if (jobs.some(job => job.status !== 'completed')) process.exitCode = 1;
