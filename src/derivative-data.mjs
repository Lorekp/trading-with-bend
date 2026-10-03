import { freeze, hash, integer, nat, requireThat } from './core.mjs';
import { validateInstrument } from './information-source.mjs';
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
  keys(input.contract, ['kind', 'payoff', 'contractValue', 'settlementScale', 'expiryTime', 'fundingIntervalMs', 'fundingOffsetMs'], 'contract');
  const c = input.contract;
  requireThat(['future', 'perpetual'].includes(c.kind) && ['linear', 'inverse'].includes(c.payoff), 'DERIVATIVE_CONTRACT', 'Declare future/perpetual and linear/inverse');
  nat(c.contractValue, 'contractValue', true);
  nat(c.settlementScale, 'settlementScale', true);
  requireThat(c.payoff !== 'linear' || c.settlementScale === '1', 'DERIVATIVE_UNITS', 'Linear prices are settlement minor units per contractValue unit; settlementScale must be 1');
  if (c.kind === 'perpetual') {
    const interval = nat(c.fundingIntervalMs, 'fundingIntervalMs', true);
    requireThat(nat(c.fundingOffsetMs, 'fundingOffsetMs') < interval && c.expiryTime === undefined, 'DERIVATIVE_CONTRACT', 'Perpetual funding offset must be less than interval; no expiry');
  } else {
    nat(c.expiryTime, 'expiryTime');
    requireThat(c.fundingIntervalMs === undefined && c.fundingOffsetMs === undefined, 'DERIVATIVE_CONTRACT', 'Dated futures cannot have funding');
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
  keys(data, ['startTime', 'endTime', 'events'], 'dataset');
  const start = nat(data.startTime, 'startTime'), end = nat(data.endTime, 'endTime');
  requireThat(start <= end && Array.isArray(data.events), 'DERIVATIVE_DATA', 'Provide ordered events and an inclusive coverage interval');
  const events = [], seen = new Map(), funding = new Set();
  let lastTime = null, lastSequence = null, settlements = 0;
  const fields = { quote: ['bid', 'ask', 'bidLots', 'askLots'], mark: ['price'], funding: ['ratePpm', 'price'], settlement: ['price'] };
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
      requireThat(abs(integer(event.ratePpm, 'ratePpm')) <= 1000000n, 'DERIVATIVE_FUNDING', 'Funding rate magnitude must not exceed 100% per interval');
      const interval = BigInt(c.fundingIntervalMs), offset = BigInt(c.fundingOffsetMs);
      requireThat(time >= offset && (time - offset) % interval === 0n && !funding.has(event.time), 'DERIVATIVE_FUNDING', 'Funding must occur exactly once on each scheduled timestamp');
      funding.add(event.time);
    }
    if (event.type === 'settlement') {
      requireThat(c.kind === 'future' && event.time === c.expiryTime && settlements++ === 0, 'DERIVATIVE_SETTLEMENT', 'Settlement must occur once, at expiry');
    }
    events.push(structuredClone(event));
  }
  if (c.kind === 'perpetual') {
    const interval = BigInt(c.fundingIntervalMs), offset = BigInt(c.fundingOffsetMs);
    const first = start <= offset ? offset : offset + ceil(start - offset, interval) * interval;
    const expected = first > end ? 0n : (end - first) / interval + 1n;
    requireThat(BigInt(funding.size) === expected, 'MISSING_FUNDING', 'Coverage requires every scheduled funding event, including explicit zero rates');
  } else if (BigInt(c.expiryTime) >= start && BigInt(c.expiryTime) <= end) {
    requireThat(settlements === 1, 'MISSING_SETTLEMENT', 'Coverage includes expiry but no settlement price');
  }
  return freeze({ startTime: data.startTime, endTime: data.endTime, events });
}
