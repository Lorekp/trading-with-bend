import { hash, nat, requireThat, immutableCopy, freeze as freezeData } from './core.mjs';
import { validateTicks } from './data.mjs';
import { validateBars } from './bars.mjs';
import { assertQuoteInstrument, isQuoteDataset } from './quote-data.mjs';
import { ReplayRecording, openReplayAudit } from './recording.mjs';

// Canonical economic identity/units, independent of a vendor's native symbol.
export function validateInstrument(instrument) {
  requireThat(instrument && ['symbol', 'currency', 'lotSize'].every(key => typeof instrument[key] === 'string' && instrument[key].length > 0),
    'ADAPTER_INSTRUMENT', 'Adapters must declare canonical symbol, currency and lotSize');
}

export function validateObservation(observation, previousTime = null) {
  requireThat(observation && Object.keys(observation).every(key => ['time', 'availableAt', 'data'].includes(key)) && observation.data && typeof observation.data === 'object',
    'INFORMATION_SCHEMA', 'Information observations contain only time, availableAt and market/features data');
  const time = nat(observation.time, 'observation.time'), available = nat(observation.availableAt, 'observation.availableAt');
  requireThat(time <= available && (previousTime === null || available >= previousTime), 'INFORMATION_TIME', 'Observations must be published in availability order, never before observation time');
  return available;
}

/** InformationSource: immutable market/features observations, with no execution methods. */
export class InformationSource {
  #observations;
  constructor({ id, instrument, observations, datasetHash }) {
    requireThat(typeof id === 'string' && id.length > 0 && Array.isArray(observations), 'INFORMATION_SOURCE', 'Source identity and observations are required');
    validateInstrument(instrument);
    let previous = null;
    for (const observation of observations) previous = validateObservation(observation, previous);
    this.#observations = freezeData(structuredClone(observations));
    this.instrument = freezeData(structuredClone(instrument));
    this.manifest = freezeData({ id, datasetHash: datasetHash ?? hash(this.#observations), observationsHash: hash(this.#observations), instrument: this.instrument });
    Object.freeze(this);
  }
  observations() { return this.#observations.values(); }
}

/** Admit asynchronous market/features data once, then replay synchronous cursors. */
export async function prepareInformationSource({ id, instrument, observations, directory, datasetHash }) {
  requireThat(typeof id === 'string' && id.length > 0, 'INFORMATION_SOURCE', 'Source identity is required');
  validateInstrument(instrument);
  requireThat(observations && (typeof observations[Symbol.iterator] === 'function' || typeof observations[Symbol.asyncIterator] === 'function'),
    'INFORMATION_SOURCE', 'Observations must be iterable');
  requireThat(typeof directory === 'string' && directory.length > 0, 'DATA_DIRECTORY', 'Information preparation requires a new directory');
  requireThat(datasetHash === undefined || typeof datasetHash === 'string' && datasetHash.length > 0, 'INFORMATION_SOURCE', 'Dataset identity must be a nonempty string');
  const canonicalInstrument = immutableCopy(instrument), recording = new ReplayRecording(directory), records = recording.series('observations');
  let previous = null;
  try {
    for await (const input of observations) {
      const observation = immutableCopy(input);
      previous = validateObservation(observation, previous);
      recording.transaction(() => records.push(observation));
    }
    const audit = recording.seal({ kind: 'information-source', id, instrument: canonicalInstrument, datasetHash: datasetHash ?? records.hash });
    return openPreparedInformationSource(audit);
  } catch (error) { recording.abort(); throw error; }
}

/** Reopen verified admitted data; callers own close() after all replays finish. */
export function openPreparedInformationSource(input, { id } = {}) {
  const audit = openReplayAudit(input), metadata = audit.manifest.metadata;
  try {
    requireThat(metadata?.kind === 'information-source' && audit.manifest.streams.observations?.kind === 'series',
      'INFORMATION_SOURCE', 'Expected prepared information observations');
    validateInstrument(metadata.instrument);
    const identity = id ?? metadata.id;
    requireThat(typeof identity === 'string' && identity.length > 0, 'INFORMATION_SOURCE', 'Source identity is required');
    let closed = false;
    return Object.freeze({ instrument: metadata.instrument,
      manifest: freezeData({ id: identity, instrument: metadata.instrument, datasetHash: metadata.datasetHash,
        observationsHash: audit.manifest.streams.observations.hash, audit: audit.manifest }),
      *observations() {
        requireThat(!closed, 'INFORMATION_CLOSED', 'Prepared information source is closed');
        const iterator = audit.records('observations');
        let previous = null;
        try {
          while (true) {
            requireThat(!closed, 'INFORMATION_CLOSED', 'Prepared information source is closed');
            const next = iterator.next();
            if (next.done) return;
            previous = validateObservation(next.value, previous);
            yield next.value;
          }
        } finally { iterator.return?.(); }
      },
      close() { if (!closed) { closed = true; audit.close(); } },
    });
  } catch (error) { audit.close(); throw error; }
}

export function quoteInformationSource({ id, instrument, ticks }) {
  if (isQuoteDataset(ticks)) {
    assertQuoteInstrument(ticks,instrument);
    requireThat(typeof id === 'string' && id.length > 0,'INFORMATION_SOURCE','Source identity is required');
    return Object.freeze({instrument:ticks.instrument,
      manifest:freezeData({id,datasetHash:ticks.manifest.datasetHash,observationsHash:ticks.manifest.observationsHash,instrument:ticks.instrument}),
      *observations() { for(const quote of ticks.rows()) yield freezeData({time:quote.sourceTime,availableAt:quote.time,data:quote}); },
    });
  }
  const quotes = validateTicks(ticks, { instrument });
  return new InformationSource({ id, instrument, datasetHash: hash(quotes), observations: quotes.map(quote => ({ time: quote.sourceTime, availableAt: quote.time, data: quote })) });
}

export function barInformationSource({ id, instrument, bars }) {
  const validated = validateBars(bars, instrument);
  return new InformationSource({ id, instrument, datasetHash: hash(validated), observations: validated.map(bar => ({ time: bar.closeTime, availableAt: bar.availableAt, data: bar })) });
}
