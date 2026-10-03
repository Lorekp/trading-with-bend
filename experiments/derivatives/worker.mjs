import { readFileSync } from 'node:fs';
import { DerivativeExecutionVenue, InformationSource, runStrategy, targetPosition, walkForwardSplits, foldRows, hash } from '../../src/index.mjs';
import { integer, requireThat } from '../../src/core.mjs';

/** A fresh collateral account per evaluation window; no cross-fold exposure. */
export function evaluateWindow({ config, data, rows, targetLots }) {
  integer(targetLots, 'targetLots');
  const source = new InformationSource({ id: 'derivative-study/signals', instrument: config.instrument,
    observations: rows.map(row => ({ time: row.time, availableAt: row.availableAt ?? row.time, data: { id: row.id } })) });
  const venue = new DerivativeExecutionVenue({ id: 'derivative-study/execution', config, data });
  return runStrategy(source, venue, targetPosition(targetLots)).report();
}

/** Dataset JSON contains normalized venue data and independently timed samples.
 * Declare datasetPath and this worker's helpers as registry dependencies.
 */
export default async function(configuration, context) {
  const { config, datasetPath, split, parameters: { targetLots } } = configuration;
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const plan = walkForwardSplits(dataset.samples, split);
  context.writeArtifact('split-plan.json', plan);
  context.writeArtifact('dataset-identity.json', { hash: hash(dataset), sampleHash: plan.datasetHash });
  const folds = [];
  for (const fold of plan.folds) {
    // This constant-exposure baseline does not fit a model or read training labels.
    const validation = foldRows(dataset.samples, plan, fold.id, 'select', 'validation');
    const report = evaluateWindow({ config, data: dataset.data, rows: validation.rows, targetLots });
    context.writeArtifact(`${fold.id}.json`, { partition: validation, report });
    requireThat(report.status === 'valid-under-declared-model', 'INVALID_REPORT', `Invalid derivative evaluation in ${fold.id}`);
    folds.push({ id: fold.id, netPnl: report.performance.netPnl, traceHash: report.traceHash });
  }
  return { datasetHash: hash(dataset), planHash: hash(plan), targetLots, folds,
    validationPnl: String(folds.reduce((sum, fold) => sum + BigInt(fold.netPnl), 0n)),
    convention: 'Sum of independent validation-window net P&L in settlement minor units; no final data used' };
}
