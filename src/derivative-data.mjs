import { freeze, hash, nat, requireThat } from './core.mjs';
import { validateInstrument } from './information-source.mjs';
import { rationalStrings } from './decimal.mjs';
const admitted = new WeakMap();
const abs = n => n < 0n ? -n : n;
const ceil = (n, d) => (n + d - 1n) / d;

function keys(value, allowed, name) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), 'DERIVATIVE_SCHEMA', `Unsupported ${name} fields`);
}
export function derivativeConfig(input) {
  keys(input, ['instrument', 'contract', 'initialCash', 'maxPositionLots', 'initialMarginBps', 'maintenanceMarginBps', 'feeBps', 'liquidationFeeBps', 'slippageBps', 'orderLatencyMs', 'cancelLatencyMs', 'maxQuoteAgeMs', 'maxMarkAgeMs'], 'configuration');
  validateInstrument(input.instrument);
  keys(input.instrument, ['symbol', 'currency', 'lotSize', 'priceTick'], 'instrument');
  requireThat(/^[1-9][0-9]*(\.[0-9]+)?$|^0\.[0-9]*[1-9][0-9]*$/.test(input.instrument.lotSize), 'INVALID_LOT_SIZE', 'lotSize must be a positive decimal descriptor');
  nat(input.instrument.priceTick, 'priceTick', true);
  keys(input.contract, ['kind', 'payoff', 'contractValue', 'settlementScale', 'expiryTime', 'fundingIntervalMs', 'fundingOffsetMs', 'fundingTimestampToleranceMs'], 'contract');
  const c = input.contract;
  requireThat(['future', 'perpetual'].includes(c.kind) && ['linear', 'inverse'].includes(c.payoff), 'DERIVATIVE_CONTRACT', 'Declare future/perpetual and linear/inverse');
  nat(c.contractValue, 'contractValue', true);
  nat(c.settlementScale, 'settlementScale', true);
  requireThat(c.payoff !== 'linear' || c.settlementScale === '1', 'DERIVATIVE_UNITS', 'Linear prices are settlement minor units per contractValue unit; settlementScale must be 1');
  if (c.kind === 'perpetual') {
    const interval = nat(c.fundingIntervalMs, 'fundingIntervalMs', true);
    requireThat(nat(c.fundingOffsetMs, 'fundingOffsetMs') < interval && c.expiryTime === undefined, 'DERIVATIVE_CONTRACT', 'Perpetual funding offset must be less than interval; no expiry');
    requireThat(nat(c.fundingTimestampToleranceMs ?? '0', 'fundingTimestampToleranceMs') < interval, 'DERIVATIVE_CONTRACT', 'Funding timestamp tolerance must be less than the funding interval');
  } else {
    nat(c.expiryTime, 'expiryTime');
    requireThat(c.fundingIntervalMs === undefined && c.fundingOffsetMs === undefined && c.fundingTimestampToleranceMs === undefined, 'DERIVATIVE_CONTRACT', 'Dated futures cannot have funding');
  }
  for (const name of ['initialCash', 'maxPositionLots', 'initialMarginBps', 'maintenanceMarginBps', 'feeBps', 'liquidationFeeBps', 'slippageBps', 'orderLatencyMs', 'cancelLatencyMs', 'maxQuoteAgeMs', 'maxMarkAgeMs']) {
    nat(input[name], name, ['initialCash', 'maxPositionLots', 'initialMarginBps', 'maintenanceMarginBps'].includes(name));
  }
  requireThat(BigInt(input.maintenanceMarginBps) < BigInt(input.initialMarginBps) && BigInt(input.initialMarginBps) <= 10000n, 'DERIVATIVE_MARGIN', 'Require 0 < maintenance < initial margin <= 10000 bps');
  for (const name of ['feeBps', 'liquidationFeeBps', 'slippageBps']) requireThat(BigInt(input[name]) < 10000n, 'DERIVATIVE_RATE', `${name} must be below 10000 bps`);
  return freeze(structuredClone(input));
}

/** Strict normalized venue data, independently usable before a Bend build. */
export function validateDerivativeData(data, configuration) {
  const config = derivativeConfig(configuration), c = config.contract;
  const identity = hash({ instrument: config.instrument, contract: c });
  const known = admitted.get(data);
  if (known) {
    requireThat(known.identity === identity, 'UNIT_MISMATCH', 'Admitted dataset requires the same instrument and contract');
    return data;
  }
  keys(data, ['startTime', 'endTime', 'events'], 'dataset');
  const start = nat(data.startTime, 'startTime'), end = nat(data.endTime, 'endTime');
  requireThat(start <= end && Array.isArray(data.events), 'DERIVATIVE_DATA', 'Provide ordered events and an inclusive coverage interval');
  const events = [], seen = new Map(), funding = new Set();
  let lastTime = null, lastSequence = null, settlements = 0;
  const fields = { quote: ['bid', 'ask', 'bidLots', 'askLots'], mark: ['price'], funding: ['rate', 'price'], settlement: ['price'] };
  for (const event of data.events) {
    requireThat(Object.hasOwn(fields, event?.type), 'DERIVATIVE_EVENT', 'Unknown derivative event type');
    keys(event, ['id', 'type', 'time', 'sequence', 'sourceTime', 'symbol', 'currency', ...fields[event.type]], 'event');
    requireThat(typeof event.id === 'string' && event.id.length > 0, 'DERIVATIVE_EVENT', 'Event identity required');
    const digest = hash(event);
    if (seen.has(event.id)) {
      requireThat(seen.get(event.id) === digest, 'EVENT_ID_COLLISION', 'Event ID changed content');
      continue;
    }
    seen.set(event.id, digest);
    const time = nat(event.time, 'event.time'), sequence = nat(event.sequence, 'event.sequence');
    requireThat(time >= start && time <= end && (lastTime === null || time >= lastTime) && (lastSequence === null || sequence > lastSequence), 'OUT_OF_ORDER', 'Events must be within coverage, chronological, with increasing sequences');
    requireThat(nat(event.sourceTime, 'sourceTime') === time, 'NON_EXECUTABLE_QUOTE', 'Venue event sourceTime must equal time');
    requireThat(event.symbol === config.instrument.symbol && event.currency === config.instrument.currency, 'UNIT_MISMATCH', 'Event identity/settlement currency mismatch');
    lastTime = time; lastSequence = sequence;
    if (event.type === 'quote') {
      const bid = nat(event.bid, 'bid', true), ask = nat(event.ask, 'ask', true), tick = BigInt(config.instrument.priceTick);
      requireThat(bid <= ask && bid % tick === 0n && ask % tick === 0n, 'DERIVATIVE_QUOTE', 'Executable quotes must be uncrossed and on tick');
      nat(event.bidLots, 'bidLots'); nat(event.askLots, 'askLots');
    } else nat(event.price, 'price', true);
    if (event.type === 'funding') {
      requireThat(c.kind === 'perpetual', 'DERIVATIVE_FUNDING', 'Funding is only valid for perpetuals');
      keys(event.rate, ['numerator', 'denominator'], 'funding rate');
      requireThat(typeof event.rate.numerator === 'string' && /^(0|-?[1-9][0-9]{0,79})$/.test(event.rate.numerator)
        && typeof event.rate.denominator === 'string' && /^[1-9][0-9]{0,79}$/.test(event.rate.denominator),
      'DERIVATIVE_FUNDING', 'Funding rate requires canonical signed numerator and positive denominator (at most 80 digits)');
      requireThat(abs(BigInt(event.rate.numerator)) <= BigInt(event.rate.denominator), 'DERIVATIVE_FUNDING', 'Funding rate magnitude must not exceed 100% per interval');
      const interval = BigInt(c.fundingIntervalMs), offset = BigInt(c.fundingOffsetMs);
      requireThat(time >= offset && (time - offset) % interval <= BigInt(c.fundingTimestampToleranceMs ?? '0'), 'DERIVATIVE_FUNDING', 'Funding must occur on schedule, within the explicitly permitted timestamp delay');
      const scheduled = String(time - (time - offset) % interval);
      requireThat(!funding.has(scheduled), 'DERIVATIVE_FUNDING', 'Funding must occur exactly once for each scheduled timestamp');
      funding.add(scheduled);
    }
    if (event.type === 'settlement') {
      requireThat(c.kind === 'future' && event.time === c.expiryTime && settlements++ === 0, 'DERIVATIVE_SETTLEMENT', 'Settlement must occur once, at expiry');
    }
    events.push({ ...structuredClone(event), ...(event.type === 'funding' ? { rate: rationalStrings({ numerator: BigInt(event.rate.numerator), denominator: BigInt(event.rate.denominator) }) } : {}) });
  }
  if (c.kind === 'perpetual') {
    const interval = BigInt(c.fundingIntervalMs), offset = BigInt(c.fundingOffsetMs);
    const first = start <= offset ? offset : offset + ceil(start - offset, interval) * interval;
    const expected = first > end ? 0n : (end - first) / interval + 1n;
    requireThat(BigInt([...funding].filter(time => BigInt(time) >= start).length) === expected, 'MISSING_FUNDING', 'Coverage requires every scheduled funding event, including explicit zero rates');
  } else if (BigInt(c.expiryTime) >= start && BigInt(c.expiryTime) <= end) {
    requireThat(settlements === 1, 'MISSING_SETTLEMENT', 'Coverage includes expiry but no settlement price');
  }
  const result = freeze({ startTime: data.startTime, endTime: data.endTime, events });
  const indexes = { quote: [], mark: [], settlement: [] };
  for (let i = 0; i < events.length; i++) if (indexes[events[i].type]) indexes[events[i].type].push(i);
  admitted.set(result, { identity, datasetHash: hash(result), indexes });
  return result;
}

// Internal window seam: admission is shared; account state never is. Search the
// immutable indexes instead of replaying a flat account through each prefix.
export function derivativeDataWindow(input, configuration, window) {
  const data = validateDerivativeData(input, configuration), metadata = admitted.get(data);
  if (window !== undefined) keys(window, ['startTime', 'endTime'], 'window');
  const startTime = window?.startTime ?? data.startTime, endTime = window?.endTime ?? data.endTime;
  const start = nat(startTime, 'window.startTime'), end = nat(endTime, 'window.endTime');
  requireThat(start >= BigInt(data.startTime) && end <= BigInt(data.endTime) && start <= end, 'DATA_COVERAGE', 'Window must lie inside admitted coverage');
  const lowerBound = indexes => {
    let low = 0, high = indexes?.length ?? data.events.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2), index = indexes ? indexes[middle] : middle;
      if (BigInt(data.events[index].time) < start) low = middle + 1; else high = middle;
    }
    return low;
  };
  const previous = kind => {
    const indexes = metadata.indexes[kind], at = lowerBound(indexes);
    return at === 0 ? null : data.events[indexes[at - 1]];
  };
  return { data, datasetHash: metadata.datasetHash, startTime, endTime, cursor: lowerBound(),
    mark: previous('mark'), quote: previous('quote'), settlement: previous('settlement') };
}
