import { readFileSync } from 'node:fs';
import { DerivativeExecutionVenue, InformationSource, runStrategy, targetPosition, walkForwardSplits, hash } from '../../src/index.mjs';
import { validateDerivativeData } from '../../src/derivative-data.mjs';
import { integer, requireThat } from '../../src/core.mjs';
import { evaluateStudy } from '../../src/study.mjs';

/** A fresh collateral account per evaluation window; no cross-fold exposure. */
export function evaluateWindow({ config, data, rows, targetLots }) {
  integer(targetLots, 'targetLots');
  requireThat(rows.length > 0, 'EVALUATION_EMPTY', 'Evaluation window requires at least one signal');
  const source = new InformationSource({ id: 'derivative-study/signals', instrument: config.instrument,
    observations: rows.map(row => ({ time: row.time, availableAt: row.availableAt ?? row.time, data: { id: row.id } })) });
  const venue = new DerivativeExecutionVenue({ id: 'derivative-study/execution', config, data,
    window: { startTime: rows[0].availableAt ?? rows[0].time, endTime: rows.at(-1).availableAt ?? rows.at(-1).time } });
  return runStrategy(source, venue, targetPosition(targetLots)).report();
}

/** Dataset JSON contains normalized venue data and independently timed samples.
 * Declare datasetPath and this worker's helpers as registry dependencies.
 */
export default async function(configuration, context) {
  const { config, datasetPath, split, evaluationProtocol, parameters: { targetLots } } = configuration;
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const admittedData = validateDerivativeData(dataset.data, config);
  const plan = walkForwardSplits(dataset.samples, split);
  context.writeArtifact('split-plan.json', plan);
  context.writeArtifact('dataset-identity.json', { hash: hash(dataset), sampleHash: plan.datasetHash });
  const study = await evaluateStudy({ samples: dataset.samples, plan, protocol: evaluationProtocol }, ({ evaluation }) => {
    // This constant-exposure baseline does not fit a model or read training labels.
    const rows = evaluation.rows;
    return { strategy: targetPosition(targetLots), baselines: { cash: targetPosition('0'), hold: targetPosition('1') },
      createReplay: () => ({
        informationSource: new InformationSource({ id: 'derivative-study/signals', instrument: config.instrument,
          observations: rows.map(row => ({ time: row.time, availableAt: row.availableAt ?? row.time, data: { id: row.id } })) }),
        executionVenue: new DerivativeExecutionVenue({ id: 'derivative-study/execution', config, data: admittedData,
          window: { startTime: rows[0].availableAt ?? rows[0].time, endTime: rows.at(-1).availableAt ?? rows.at(-1).time } })
      }) };
  });
  context.writeArtifact('study.json', study);
  return { datasetHash: hash(dataset), targetLots, study };
}
