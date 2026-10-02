import { hash, nat, requireThat } from './core.mjs';
import { populationMoments, stableMean } from './numerics.mjs';

const finite = (value, name) => {
  requireThat(typeof value === 'number' && Number.isFinite(value), 'NONFINITE_FEATURE', `${name} must be a finite number`);
  return value;
};
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const sealed = body => freeze({ ...body, hash: hash(body) });

/** Feature order, units, source fields and trailing-window definitions are part of the schema identity. */
export function featureSchema(schema) {
  requireThat(Array.isArray(schema) && schema.length > 0, 'FEATURE_SCHEMA', 'Provide an ordered, nonempty feature schema');
  const names = new Set();
  const result = Array.from(schema, (entry, i) => {
    requireThat(entry && typeof entry === 'object' && !Array.isArray(entry), 'FEATURE_SCHEMA', `Feature ${i} must be a descriptor`);
    for (const key of Object.keys(entry)) requireThat(['name', 'source', 'kind', 'unit', 'window', 'lag'].includes(key), 'FEATURE_SCHEMA', `Unsupported feature option ${key}`);
    for (const key of ['name', 'source', 'unit']) requireThat(typeof entry[key] === 'string' && entry[key].length > 0, 'FEATURE_SCHEMA', `Feature ${key} is required`);
    requireThat(!names.has(entry.name), 'FEATURE_SCHEMA', 'Feature names must be unique'); names.add(entry.name);
    requireThat(['value', 'lag', 'mean', 'std', 'return'].includes(entry.kind), 'FEATURE_SCHEMA', 'Unsupported feature kind');
    const windowed = ['mean', 'std'].includes(entry.kind), lagged = ['lag', 'return'].includes(entry.kind);
    requireThat(windowed ? Number.isSafeInteger(entry.window) && entry.window >= 1 && entry.window <= 1_000_000 : entry.window === undefined, 'FEATURE_SCHEMA', 'Trailing windows must be positive integers at most 1000000, and apply only to mean/std');
    requireThat(lagged ? Number.isSafeInteger(entry.lag) && entry.lag >= 1 && entry.lag <= 1_000_000 : entry.lag === undefined, 'FEATURE_SCHEMA', 'Past lags must be positive integers at most 1000000, and apply only to lag/return');
    return { name: entry.name, source: entry.source, kind: entry.kind, unit: entry.unit, ...(windowed ? { window: entry.window } : {}), ...(lagged ? { lag: entry.lag } : {}) };
  });
  return freeze(result);
}

export function validateFeatureArtifact(feature, schema, { allowWarmup = false } = {}) {
  requireThat(feature && typeof feature === 'object' && !Array.isArray(feature), 'FEATURE_ARTIFACT', 'Feature artifact is required');
  const { hash: digest, ...body } = feature;
  requireThat(feature.format === 'trailing-features-v1' && typeof digest === 'string' && digest === hash(body), 'FEATURE_ARTIFACT', 'Feature artifact content hash is invalid');
  const expected = featureSchema(schema);
  requireThat(feature.schemaHash === hash(expected), 'FEATURE_SCHEMA', 'Feature names, order, definitions or units differ');
  requireThat(nat(feature.time, 'feature.time') <= nat(feature.availableAt, 'feature.availableAt'), 'FEATURE_AVAILABILITY', 'Feature availability precedes observation');
  requireThat(Array.isArray(feature.values) && feature.values.length === expected.length, 'FEATURE_SCHEMA', 'Feature vector length differs');
  for (const value of feature.values) if (value !== null) finite(value, 'Feature value');
  const ready = feature.values.every(value => value !== null);
  requireThat(feature.ready === ready, 'FEATURE_ARTIFACT', 'Feature readiness disagrees with values');
  requireThat(allowWarmup || ready, 'FEATURE_WARMUP', 'Feature history is incomplete');
  return true;
}

/** Single ordered stream. Windows include the current observation; std uses population variance. */
export class RollingFeatures {
  #schema; #history = []; #lastTime = null; #lastAvailable = null; #maxHistory; #sources;
  constructor(schema) {
    this.#schema = featureSchema(schema);
    this.#sources = [...new Set(this.#schema.map(entry => entry.source))];
    this.#maxHistory = Math.max(...this.#schema.map(entry => entry.window ?? (entry.lag === undefined ? 1 : entry.lag + 1)));
  }
  get schema() { return this.#schema; }
  get schemaHash() { return hash(this.#schema); }
  update(row) {
    requireThat(row && typeof row === 'object', 'FEATURE_INPUT', 'Feature observation is required');
    const time = nat(row.time, 'observation.time'), available = nat(row.availableAt, 'observation.availableAt');
    requireThat(time <= available, 'FEATURE_AVAILABILITY', 'Observation is unavailable before its event time');
    requireThat(this.#lastTime === null || time > this.#lastTime, 'FEATURE_ORDER', 'Observation time must strictly increase within a stream');
    requireThat(this.#lastAvailable === null || available >= this.#lastAvailable, 'FEATURE_ORDER', 'Availability must not decrease; late revisions require a new stream');
    requireThat(row.values && typeof row.values === 'object' && !Array.isArray(row.values), 'FEATURE_INPUT', 'Observation values must be named fields');
    const current = Object.fromEntries(this.#sources.map(source => [source, finite(Object.hasOwn(row.values, source) ? row.values[source] : undefined, source)]));
    const history = [...this.#history, current].slice(-this.#maxHistory);
    const values = this.#schema.map(entry => {
      const latest = current[entry.source];
      if (entry.kind === 'value') return latest;
      if (entry.kind === 'lag' || entry.kind === 'return') {
        if (history.length <= entry.lag) return null;
        const past = history[history.length - entry.lag - 1][entry.source];
        if (entry.kind === 'lag') return past;
        requireThat(past !== 0, 'FEATURE_DIVISION', 'Return denominator is zero');
        return finite(latest / past - 1, entry.name);
      }
      if (history.length < entry.window) return null;
      const samples = history.slice(-entry.window).map(item => item[entry.source]);
      if (entry.kind === 'mean') return stableMean(samples);
      return populationMoments(samples).standardDeviation;
    });
    const artifact = sealed({ format: 'trailing-features-v1', schemaHash: this.schemaHash, time: row.time, availableAt: row.availableAt, values, ready: values.every(value => value !== null) });
    // Invalid input or arithmetic leaves the stream intact.
    this.#history = history; this.#lastTime = time; this.#lastAvailable = available;
    return artifact;
  }
}

export function computeFeatures(rows, schema) {
  requireThat(Array.isArray(rows), 'FEATURE_INPUT', 'Batch observations must be an array');
  const stream = new RollingFeatures(schema);
  return rows.map(row => stream.update(row));
}
