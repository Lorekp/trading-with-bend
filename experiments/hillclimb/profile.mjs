import { readFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { enqueueExperiment, runQueue, readExperimentResult } from '../../src/experiments.mjs';
import { requireThat } from '../../src/core.mjs';
import { resolveProtocol } from '../speed/protocol.mjs';

// Reuse a saved benchmark run request, outside any timed comparison.
const [input, output] = process.argv.slice(2);
requireThat(input && output, 'PROFILE_ARGUMENTS', 'Usage: node experiments/hillclimb/profile.mjs <run-request.json> <new-registry>');
const requestPath = resolve(input), registry = resolve(output);
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
requireThat(request.action === 'run', 'PROFILE_REQUEST', 'Expected a benchmark run request');
const protocol = resolveProtocol(JSON.parse(readFileSync(request.protocolPath, 'utf8')));
process.env.NODE_OPTIONS = `--max-old-space-size=${protocol.heapMiB}`;
const manifest = JSON.parse(readFileSync(request.configuration.manifestPath, 'utf8'));
mkdirSync(dirname(registry), { recursive: true });
mkdirSync(registry); // Retain every attempt; never reuse a profiling registry.
const key = `hillclimb/profile/${basename(registry)}`;
enqueueExperiment(registry, { key, workerModule: new URL('./profile-worker.mjs', import.meta.url),
  configuration: request.configuration, seed: request.configuration.seed,
  dependencies: [requestPath, request.protocolPath, request.configuration.manifestPath,
    join(dirname(request.configuration.manifestPath), manifest.file), new URL('../speed/worker.mjs', import.meta.url)] });
const jobs = await runQueue(registry, { concurrency: 1, timeoutMs: request.timeoutMs });
if (jobs.some(job => job.status !== 'completed')) {
  console.error(JSON.stringify(jobs, null, 2));
  process.exitCode = 1;
} else console.log(JSON.stringify({ registry, key, result: readExperimentResult(registry, key) }, null, 2));
