import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { enqueueExperiment, runQueue, readExperimentResult, forecastRuntime } from '../src/index.mjs';

// No manifest means a small deterministic fixture. Supply a verified Binance
// manifest for real one-minute data; default to its first day for pipeline work.
const root = resolve(process.argv[2] || `output/eth-forecast-${randomUUID()}`);
const manifestPath = process.argv[3] ? resolve(process.argv[3]) : null;
const maxBars = Number(process.argv[4] || (manifestPath ? 1440 : 600));
const python = process.env.ML_PYTHON || 'python';
const environment = forecastRuntime({ python });
const dependencies = ['../experiments/eth-forecast/data.mjs', '../src/ml/forecast.py', '../requirements-ml.txt'].map(path => new URL(path, import.meta.url));
if (manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dataset = manifest.datasets.find(item => item.type === 'klines');
  if (dataset?.status !== 'complete' || !dataset.files?.length) throw new Error('Complete klines manifest required');
  dependencies.push(manifestPath);
  for (const file of dataset.files) {
    if (file.status !== 'verified') throw new Error('Every klines archive must be verified');
    const archive = isAbsolute(file.path) ? file.path : resolve(dirname(manifestPath), file.path);
    dependencies.push(archive, `${archive}.CHECKSUM`);
  }
}
for (const kind of ['zero', 'ridge', 'lightgbm', 'tcn']) enqueueExperiment(root, {
  key: `eth-forecast-v1/${kind}`, workerModule: new URL('../experiments/eth-forecast/worker.mjs', import.meta.url), dependencies,
  seed: 41, configuration: { kind, manifestPath, maxBars, datasetSeed: 41, python, environment },
});
console.log(JSON.stringify({ registry: root, status: 'running', environment }));
const jobs = await runQueue(root, { concurrency: 1, timeoutMs: 300000 });
const trials = jobs.map(job => job.status === 'completed' ? { key: job.key, status: job.status, ...readExperimentResult(root, job.key) } :
  { key: job.key, status: job.status, error: job.attempts.at(-1)?.error ?? null });
const summary = { scope: 'Validation selection only; all trials retained; final holdout unreleased', trials };
writeFileSync(resolve(root, `summary-${randomUUID()}.json`), JSON.stringify(summary, null, 2), { flag: 'wx' });
console.log(JSON.stringify(summary, null, 2));
if (trials.some(trial => trial.status !== 'completed')) process.exitCode = 1;
