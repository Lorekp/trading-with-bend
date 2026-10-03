import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runMemoryBenchmark } from '../experiments/memory/benchmark.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run benchmark:memory -- [--plan plan.json] [--suite smoke-v1|replay-v1|campaign-v1|replay-demanding-v1|controls-v1|churn-v1|restore-v1|retention-v1|overhead-v1|collector-calibration-v1] [--output new-directory] [--ticks N] [--workers N] [--jobs N] [--repetitions N] [--sample-ms N] [--timeout-ms N] [--dataset manifest.json] [--node-options heap-flags] [--budget-bytes N]');
} else {
  const options = {};
  const allowed = ['plan', 'suite', 'output', 'ticks', 'workers', 'jobs', 'repetitions', 'sample-ms', 'timeout-ms', 'dataset', 'node-options', 'budget-bytes', 'order-every', 'order-seed', 'cgroup-parent'];
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, ''), value = args[i + 1];
    if (!args[i]?.startsWith('--') || !allowed.includes(name) || value === undefined || name in options) throw new Error(`Invalid benchmark option ${args[i]}`);
    options[name] = value;
  }
  let plan;
  if (options.plan) {
    if (Object.keys(options).some(key => !['plan', 'output'].includes(key))) throw new Error('Use --plan with only an optional --output');
    plan = JSON.parse(readFileSync(options.plan, 'utf8'));
  } else {
    plan = { version: 1, suite: options.suite ?? 'smoke-v1' };
    for (const [option, name] of Object.entries({ ticks: 'ticks', workers: 'workers', jobs: 'jobs', repetitions: 'repetitions',
      'sample-ms': 'sampleMs', 'timeout-ms': 'timeoutMs', 'budget-bytes': 'budgetBytes', 'order-every': 'orderEvery', 'order-seed': 'orderSeed' })) {
      if (options[option] !== undefined) plan[name] = Number(options[option]);
    }
    if (options.dataset) plan.datasetManifest = options.dataset;
    if (options['node-options'] || options['cgroup-parent']) plan.runtime = {
      ...(options['node-options'] ? { nodeOptions: options['node-options'] } : {}),
      ...(options['cgroup-parent'] ? { cgroupParent: options['cgroup-parent'] } : {}) };
  }
  const summary = await runMemoryBenchmark(plan, { outputDirectory: resolve(options.output ?? `output/memory/${new Date().toISOString().replace(/[:.]/g, '-')}`) });
  console.log(JSON.stringify({ status: summary.status, outputDirectory: summary.outputDirectory, cases: summary.cases }, null, 2));
  if (summary.status !== 'completed') process.exitCode = 1;
}
