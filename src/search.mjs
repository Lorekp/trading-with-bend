import { hash, requireThat } from './core.mjs';
import { canonicalExperimentJson, deterministicSeed } from './experiments.mjs';

/** Stable Cartesian product, bounded before allocation. No implicit random search. */
export function parameterGrid(space, { maxTrials = 10000 } = {}) {
  requireThat(space && typeof space === 'object' && !Array.isArray(space), 'GRID_SPACE', 'Parameter space must be an object of candidate arrays');
  requireThat(Number.isSafeInteger(maxTrials) && maxTrials > 0, 'GRID_LIMIT', 'maxTrials must be a positive integer');
  const names = Object.keys(space).sort(); let size = 1;
  for (const name of names) {
    const values = space[name];
    requireThat(Array.isArray(values) && values.length > 0, 'GRID_SPACE', `No candidates for ${name}`);
    requireThat(new Set(values.map(value => canonicalExperimentJson(value))).size === values.length, 'GRID_DUPLICATE', `Duplicate candidates for ${name}`);
    size *= values.length; requireThat(Number.isSafeInteger(size) && size <= maxTrials, 'GRID_LIMIT', 'Parameter grid exceeds maxTrials');
  }
  let rows = [{}];
  for (const name of names) rows = rows.flatMap(row => space[name].map(value => ({ ...row, [name]: structuredClone(value) })));
  return rows;
}

/** Job identities include parameters, seed, protocol and base configuration. */
export function gridJobs({ namespace, workerModule, baseConfiguration, space, dependencies = [], maxTrials = 10000, seed, partition = 'validation' }) {
  requireThat(typeof namespace === 'string' && namespace.length > 0, 'GRID_NAMESPACE', 'Provide an agent/research namespace');
  requireThat(partition === 'validation', 'SEARCH_PARTITION', 'Automated parameter search uses validation only; release final holdout separately');
  canonicalExperimentJson(baseConfiguration);
  return parameterGrid(space, { maxTrials }).map(parameters => {
    const configuration = { ...structuredClone(baseConfiguration), parameters, evaluationPartition: partition };
    const key = `${namespace}/${hash({ configuration, seed: seed ?? null })}`;
    return { key, workerModule, configuration, dependencies: [...dependencies], seed: seed ?? deterministicSeed(key) };
  });
}
