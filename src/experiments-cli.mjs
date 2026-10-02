import { readFileSync } from 'node:fs';
import { enqueueExperiment, listExperiments, recoverExperiment, runQueue } from './experiments.mjs';

const [command, root, input] = process.argv.slice(2);
const usage = 'Usage: node src/experiments-cli.mjs enqueue <registry> <jobs.json|-> | work <registry> [options.json|-] | status <registry> | recover <registry> <key>';
try {
  if (!root) throw new Error(usage);
  const readInput = () => JSON.parse(readFileSync(input === '-' ? 0 : input, 'utf8'));
  let result;
  if (command === 'enqueue' || command === 'queue') {
    if (!input) throw new Error(usage);
    const jobs = readInput();
    result = (Array.isArray(jobs) ? jobs : [jobs]).map(job => enqueueExperiment(root, job));
  } else if (command === 'work') {
    result = await runQueue(root, input ? readInput() : {});
    if (result.some(job => job.status === 'failed' || job.status === 'abandoned')) process.exitCode = 1;
  } else if (command === 'status') result = listExperiments(root);
  else if (command === 'recover') { if (!input) throw new Error(usage); result = recoverExperiment(root, input); }
  else throw new Error(usage);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: { code: error.code || 'ERROR', message: error.message } }) + '\n');
  process.exitCode = 1;
}
