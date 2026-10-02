import { hash, nat, requireThat } from './core.mjs';
import { featureSchema, validateFeatureArtifact } from './features.mjs';

/** Pack completed, regular observations oldest-first. Prices must belong to the
 * declared target venue; joining another venue's information is the caller's job.
 * Each price is available with its feature. No interpolation or missing bars.
 * latest is an unlabeled inference row, even before its future price exists. */
export function sequenceSamples({ observations, schema, instrument, venue, sequenceLength = 60, horizonSteps = 5, intervalMs = '60000' }) {
  const sourceSchema = featureSchema(schema), interval = nat(intervalMs, 'intervalMs', true);
  for (const [name, value] of Object.entries({ sequenceLength, horizonSteps })) requireThat(Number.isSafeInteger(value) && value > 0, 'SEQUENCE_ARGUMENT', `${name} must be positive`);
  requireThat([instrument, venue].every(value => typeof value === 'string' && value.length > 0), 'FORECAST_TARGET', 'Explicit instrument and target venue required');
  requireThat(Array.isArray(observations) && observations.length >= sequenceLength, 'SEQUENCE_DATA', 'Insufficient observations');
  let previous = null;
  for (const row of observations) {
    validateFeatureArtifact(row.feature, sourceSchema, { allowWarmup: true });
    requireThat(Number.isFinite(row.price) && row.price > 0, 'SEQUENCE_PRICE', 'Positive finite target prices required');
    const time = nat(row.feature.time, 'time');
    requireThat(previous === null || time - previous === interval, 'SEQUENCE_GAP', 'Observations must be unique and contiguous on the declared grid');
    requireThat(row.feature.availableAt === row.feature.time, 'SEQUENCE_AVAILABILITY', 'Use completed observation availability as the forecast timestamp');
    previous = time;
  }
  const packedSchema = featureSchema(Array.from({ length: sequenceLength }, (_, step) => sourceSchema.map(entry => ({
    name: `${entry.name}@${step - sequenceLength + 1}`, source: `${hash(entry)}@${step - sequenceLength + 1}`, kind: 'value', unit: entry.unit,
  }))).flat());
  const schemaHash = hash(packedSchema), samples = []; let latest = null;
  for (let end = sequenceLength - 1; end < observations.length; end++) {
    const window = observations.slice(end - sequenceLength + 1, end + 1);
    if (window.some(row => !row.feature.ready)) continue;
    const current = observations[end], future = observations[end + horizonSteps];
    const body = { format: 'trailing-features-v1', schemaHash, time: current.feature.time, availableAt: current.feature.availableAt,
      values: window.flatMap(row => row.feature.values), ready: true };
    latest = { id: `${instrument}/${venue}/${body.time}`, time: body.time, availableAt: body.availableAt, feature: { ...body, hash: hash(body) } };
    if (future) {
      const target = Math.log(future.price / current.price);
      requireThat(Number.isFinite(target), 'SEQUENCE_PRICE', 'Log-return target exceeds the finite numeric range');
      samples.push({ ...latest, labelAvailableAt: future.feature.availableAt, target });
    }
  }
  requireThat(latest !== null && latest.time === observations.at(-1).feature.time, 'SEQUENCE_DATA', 'No complete latest sequence after feature warmup');
  return { schema: packedSchema, samples, latest, contract: { instrument, venue, sequenceLength, featureCount: sourceSchema.length,
    intervalMs, horizonMs: String(interval * BigInt(horizonSteps)), target: 'log-close-return', sourceSchema } };
}
