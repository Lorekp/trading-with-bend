// A trusted worker is a normal ES module. Use the same contract for a rules
// strategy, model training, parameter search, or external simulator adapter.
// Return JSON; put additional immutable JSON artifacts in this attempt's folder.
import { readFile } from 'node:fs/promises';
import { Backtest } from '../src/framework.mjs';
import { hash, json } from '../src/core.mjs';

export default async function run(configuration, context) {
  const scenario = JSON.parse(await readFile(new URL(configuration.scenario ?? './demo.json', import.meta.url), 'utf8'));
  scenario.config.manifest.seed = String(context.seed);
  const report = JSON.parse(json(new Backtest(scenario.config).run(scenario.events).report()));
  context.writeArtifact('report.json', report);
  return { key: context.key, seed: context.seed, reportHash: hash(report), eventCount: scenario.events.length };
}
