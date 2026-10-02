import { hash, nat, requireThat, freeze as freezeData } from './core.mjs';
import { validateTicks } from './data.mjs';
import { validateBars } from './bars.mjs';

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

export function quoteInformationSource({ id, instrument, ticks }) {
  const quotes = validateTicks(ticks, { instrument });
  return new InformationSource({ id, instrument, datasetHash: hash(quotes), observations: quotes.map(quote => ({ time: quote.sourceTime, availableAt: quote.time, data: quote })) });
}

export function barInformationSource({ id, instrument, bars }) {
  const validated = validateBars(bars, instrument);
  return new InformationSource({ id, instrument, datasetHash: hash(validated), observations: validated.map(bar => ({ time: bar.closeTime, availableAt: bar.availableAt, data: bar })) });
}
