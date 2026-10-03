import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runBenchmark } from '../experiments/speed/benchmark.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run benchmark -- [--protocol path] [--profile smoke|pilot|release] [--baseline checkout] [--candidate checkout] [--output new-directory]');
  console.log('Defaults: quotes.json release profile, A/A using this checkout, a fresh output/benchmarks directory. Build targets first.');
} else {
  try {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index], value = args[index + 1];
      if (!['--protocol', '--profile', '--baseline', '--candidate', '--output'].includes(name) ||
        value === undefined || value.startsWith('--') || Object.hasOwn(options, name)) throw new Error(`Invalid or missing option: ${name}`);
      options[name] = value;
    }
    const protocol = JSON.parse(readFileSync(options['--protocol'] ?? new URL('../experiments/speed/quotes.json', import.meta.url), 'utf8'));
    if (options['--profile']) protocol.profile = options['--profile'];
    const outputDirectory = resolve(options['--output'] ?? `output/benchmarks/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    const report = await runBenchmark(protocol, {
      baselineRoot: options['--baseline'] ?? process.cwd(), candidateRoot: options['--candidate'] ?? process.cwd(), outputDirectory,
    });
    console.log(JSON.stringify({ status: report.status, comparisonType: report.comparisonType, outputDirectory,
      comparisons: report.comparisons, ...(report.failure ? { failure: report.failure } : {}) }, null, 2));
    if (report.status !== 'completed') process.exitCode = 1;
  } catch (error) {
    console.error(`${error.code ?? 'BENCHMARK_ERROR'}: ${error.message}`);
    process.exitCode = 1;
  }
}
