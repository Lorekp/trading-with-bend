import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { enqueueExperiment, runQueue, readExperimentResult, verifyExperimentArtifacts } from '../../src/experiments.mjs';
import { phase, publish } from './support.mjs';

const [specificationPath] = process.argv.slice(2);
const specification = JSON.parse(readFileSync(specificationPath, 'utf8'));
phase('supervisor:start');
const registry = join(specification.directory, 'registry');
for (let index = 0; index < specification.jobs; index++) {
  const configuration = { ...specification.configuration, index };
  const dependencies = [new URL('./support.mjs', import.meta.url), new URL('./extended-workloads.mjs', import.meta.url)];
  if (configuration.kind === 'calibration' && process.env.MEMORY_BENCHMARK_HELPER) dependencies.push(process.env.MEMORY_BENCHMARK_HELPER);
  if (configuration.manifestPath) {
    const manifest = JSON.parse(readFileSync(configuration.manifestPath, 'utf8'));
    dependencies.push(configuration.manifestPath, join(dirname(configuration.manifestPath), manifest.file));
  }
  if (configuration.checkpointPath) {
    const checkpoint = JSON.parse(readFileSync(configuration.checkpointPath, 'utf8'));
    const manifest = JSON.parse(readFileSync(checkpoint.audit.manifestPath, 'utf8'));
    dependencies.push(configuration.checkpointPath, checkpoint.audit.manifestPath, join(dirname(checkpoint.audit.manifestPath), manifest.file));
  }
  enqueueExperiment(registry, { key: `memory-v1/${specification.id}/${index}`, seed: index,
    workerModule: new URL('./worker.mjs', import.meta.url), configuration, dependencies });
}
phase('queue:start');
const jobs = await runQueue(registry, { concurrency: specification.concurrency, timeoutMs: specification.timeoutMs });
phase('queue:complete');
const results = jobs.map(job => {
  const attempt = job.attempts.at(-1);
  if (job.status !== 'completed') return { key: job.key, status: job.status, attempt, error: attempt?.error ?? null };
  verifyExperimentArtifacts(registry, job.key);
  return { key: job.key, status: job.status, attempt, result: readExperimentResult(registry, job.key) };
});
phase('verification:complete');
publish(join(specification.directory, 'workload.json'), { status: results.every(row => row.status === 'completed') ? 'completed' : 'failed',
  pid: process.pid, runtime: { node: process.version, nodeOptions: process.env.NODE_OPTIONS ?? '', execArgv: process.execArgv }, registry, results });
phase('publication:complete');
if (results.some(row => row.status !== 'completed')) process.exitCode = 1;
