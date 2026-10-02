import { hash, nat, requireThat, freeze as freezeData } from './core.mjs';
import { validateInstrument, validateObservation } from './information-source.mjs';

const usedVenues = new WeakSet();

/**
 * Replay seam. InformationSource supplies observations(); ExecutionVenue supplies
 * advanceTo(time), snapshot(), setTarget(target, time), finish(time), report().
 * Methods are synchronous. A fresh venue is required for each run.
 * @template Data
 * @param {import('./adapter-contracts.js').InformationSource<Data>} informationSource
 * @param {import('./adapter-contracts.js').ExecutionVenue} executionVenue
 * @param {import('./adapter-contracts.js').Strategy<Data>} strategy
 * @param {{lookback?: number}} options
 */
export function runStrategy(informationSource, executionVenue, strategy, options = {}) {
  requireThat(Object.keys(options).every(key => key === 'lookback'), 'STRATEGY_OPTION', 'Runner options contain only lookback; configure execution on the venue');
  const { lookback } = options;
  requireThat(lookback === undefined || Number.isSafeInteger(lookback) && lookback > 0, 'STRATEGY_LOOKBACK', 'lookback must be a positive safe integer');
  requireThat(informationSource && typeof informationSource.observations === 'function', 'INFORMATION_SOURCE', 'An InformationSource is required');
  requireThat(executionVenue && ['advanceTo', 'snapshot', 'setTarget', 'finish', 'report'].every(key => typeof executionVenue[key] === 'function'), 'EXECUTION_VENUE', 'An ExecutionVenue is required');
  requireThat(typeof strategy === 'function', 'STRATEGY_CALLBACK', 'A target-position strategy is required');
  const requiredLookback = strategy.lookback;
  requireThat(requiredLookback === undefined || Number.isSafeInteger(requiredLookback) && requiredLookback > 0, 'STRATEGY_LOOKBACK', 'Strategy lookback must be a positive safe integer');
  requireThat(lookback === undefined || requiredLookback === undefined || lookback >= requiredLookback, 'STRATEGY_LOOKBACK', 'lookback must cover the strategy history requirement');
  for (const adapter of [informationSource, executionVenue]) {
    validateInstrument(adapter.instrument);
    requireThat(typeof adapter.manifest?.id === 'string' && adapter.manifest.id.length > 0, 'ADAPTER_MANIFEST', 'Each adapter requires its own manifest identity');
  }
  requireThat(['symbol', 'currency', 'lotSize'].every(key => informationSource.instrument[key] === executionVenue.instrument[key]),
    'UNIT_MISMATCH', 'Source and venue must explicitly normalize to the same canonical instrument and units');
  requireThat(!usedVenues.has(executionVenue), 'VENUE_REUSED', 'Use a fresh ExecutionVenue for each replay');
  usedVenues.add(executionVenue);
  const provenance = freezeData(structuredClone({ informationSource: informationSource.manifest, executionVenue: executionVenue.manifest }));
  const history = [], targets = [];
  let previous = null, count = 0, firstObservation = null;
  for (const observation of informationSource.observations()) {
    previous = validateObservation(observation, previous);
    const time = observation.availableAt;
    executionVenue.advanceTo(time);
    const data = freezeData(structuredClone(observation.data));
    firstObservation ??= data;
    history.push(data); count++;
    if (lookback !== undefined && history.length > lookback) history.shift();
    const account = freezeData(structuredClone(executionVenue.snapshot()));
    const context = Object.freeze({ observation: data, history: Object.freeze(history.slice()),
      time, index: count - 1, tickCount: count, account, ledger: account.ledger, orders: account.orders, equity: account.equity });
    const target = strategy(context);
    requireThat(target === null || typeof target === 'string', 'STRATEGY_OUTPUT', 'Strategy must return canonical target lots or explicit null');
    if (target !== null) { nat(target, 'strategy target'); executionVenue.setTarget(target, time); }
    targets.push({ time, target });
  }
  const endTime = previous === null ? null : String(previous);
  executionVenue.finish(endTime);
  return Object.freeze({ observationCount: count, firstObservation, endTime, targetsHash: hash(targets), report() {
    return { ...executionVenue.report(), routing: provenance, signals: { count, targetsHash: hash(targets) } };
  } });
}
