import { readFileSync } from 'node:fs';
import { cancelExperiment, enqueueExperiment, listExperiments, queueStatus, recoverExperiment, recoverQueue, runQueue } from './experiments.mjs';

const [command, root, input] = process.argv.slice(2);
const usage = 'Usage: node src/experiments-cli.mjs enqueue <registry> <jobs.json|-> | work <registry> [options.json|-] | status <registry> | queue-status <registry> [options.json|-] | recover <registry> <key> | recover-queue <registry> [options.json|-] | cancel <registry> <key>';
try {
  if (!root) throw new Error(usage);
  const readInput = () => JSON.parse(readFileSync(input === '-' ? 0 : input, 'utf8'));
  let result;
  if (command === 'enqueue' || command === 'queue') {
    if (!input) throw new Error(usage);
    const jobs = readInput();
    result = (Array.isArray(jobs) ? jobs : [jobs]).map(job => enqueueExperiment(root, job));
  } else if (command === 'work') {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try { result = await runQueue(root, { ...(input ? readInput() : {}), signal: controller.signal }); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    if (result.some(job => job.status === 'failed' || job.status === 'abandoned')) process.exitCode = 1;
  } else if (command === 'status') result = listExperiments(root);
  else if (command === 'queue-status') result = queueStatus(root, input ? readInput() : {});
  else if (command === 'recover-queue') result = recoverQueue(root, input ? readInput() : {});
  else if (command === 'cancel') { if (!input) throw new Error(usage); result = cancelExperiment(root, input); }
  else if (command === 'recover') { if (!input) throw new Error(usage); result = recoverExperiment(root, input); }
  else throw new Error(usage);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: { code: error.code || 'ERROR', message: error.message } }) + '\n');
  process.exitCode = 1;
}
