import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Backtest } from './framework.mjs';
import { hash, json, requireThat } from './core.mjs';
import { runExperiment } from './research.mjs';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: npm run backtest -- input.json [--out output/report.json]\nBuild first with npm run build. See examples/demo.json.');
} else {
  try {
    requireThat(args.length === 1 || (args.length === 3 && args[1] === '--out'), 'CLI_ARGUMENTS', 'Expected input.json [--out report.json]');
    const out = args[2] || `output/reports/${randomUUID()}.json`;
    const { id, result } = runExperiment('output/experiments', { input: args[0], output: out }, recordInput => {
      const raw = readFileSync(args[0], 'utf8'); recordInput({ rawHash: hash(raw) });
      const input = JSON.parse(raw);
      requireThat(Array.isArray(input.events), 'INPUT_EVENTS', 'events must be an array');
      recordInput({ rawHash: hash(raw), config: input.config, datasetHash: hash(input.events) });
      const report = new Backtest(input.config).run(input.events).report();
      mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, json(report) + '\n', { flag: 'wx' });
      return report;
    });
    console.log(json({ experimentId: id, report: out, status: result.status, performance: result.performance }));
    if (result.dataQuality.status !== 'accepted') process.exitCode = 1;
  } catch (error) {
    console.error(json({ status: 'failed', code: error.code || 'ERROR', message: String(error.message || error) }));
    process.exitCode = 1;
  }
}
