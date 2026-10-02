import { MAX_NAT, nat, requireThat } from './core.mjs';

export const QUOTE_UNITS = Object.freeze({ time: 'ms', price: 'quote-minor-per-lot', quantity: 'lots' });
const quoteFields = ['time', 'sourceTime', 'sequence', 'bid', 'ask', 'bidLots', 'askLots'];
function instrumentSpec(instrument) {
  requireThat(instrument && typeof instrument.symbol === 'string' && instrument.symbol.length > 0 && typeof instrument.currency === 'string' && instrument.currency.length > 0,
    'DATA_INSTRUMENT', 'An instrument with symbol and currency is required');
  nat(instrument.priceTick, 'instrument.priceTick', true);
  requireThat(typeof instrument.lotSize === 'string' && /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/.test(instrument.lotSize),
    'DATA_INSTRUMENT', 'instrument.lotSize must declare a positive decimal lot size');
}

// Quotes remain in the input order. Equal exchange timestamps are allowed, but
// sequence numbers must increase; duplicate observation IDs are rejected.
export function validateTicks(ticks, { instrument } = {}) {
  instrumentSpec(instrument);
  requireThat(Array.isArray(ticks), 'DATA_SCHEMA', 'ticks must be an array');
  const ids = new Set(); let previousTime = null, previousSequence = null;
  for (const [index, tick] of ticks.entries()) {
    requireThat(tick && tick.type === 'tick' && typeof tick.id === 'string' && tick.id.length > 0, 'DATA_SCHEMA', `Invalid quote at row ${index + 1}`);
    requireThat(Object.keys(tick).every(key => ['id', 'type', 'symbol', 'currency', ...quoteFields].includes(key)), 'DATA_SCHEMA', `Unsupported quote field at row ${index + 1}`);
    requireThat(!ids.has(tick.id), 'DATA_DUPLICATE', `Duplicate quote ID at row ${index + 1}: ${tick.id}`);
    ids.add(tick.id);
    requireThat(tick.symbol === instrument.symbol && tick.currency === instrument.currency, 'UNIT_MISMATCH', `Quote row ${index + 1} uses a different instrument/currency`);
    const values = Object.fromEntries(quoteFields.map(field => [field, nat(tick[field], `row ${index + 1}.${field}`, field === 'bid' || field === 'ask')]));
    requireThat(values.sourceTime === values.time, 'NON_EXECUTABLE_QUOTE', 'Executable quotes require sourceTime = exchange time');
    requireThat(previousTime === null || values.time >= previousTime, 'OUT_OF_ORDER', 'Input quote timestamps must not decrease; ingestion does not sort');
    requireThat(previousSequence === null || values.sequence > previousSequence, 'OUT_OF_ORDER', 'Input quote sequence numbers must strictly increase');
    requireThat(values.bid <= values.ask, 'CROSSED_QUOTE', `Crossed quote at row ${index + 1}`);
    const step = BigInt(instrument.priceTick);
    requireThat(values.bid % step === 0n && values.ask % step === 0n, 'PRICE_TICK', `Quote row ${index + 1} is off tick`);
    previousTime = values.time; previousSequence = values.sequence;
  }
  return structuredClone(ticks);
}

function csvRows(csv) {
  requireThat(typeof csv === 'string', 'CSV_INPUT', 'CSV input must be text');
  if (csv.charCodeAt(0) === 0xfeff) csv = csv.slice(1);
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '"') {
        if (csv[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
      continue;
    }
    if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closed = false;
      if (char !== ',') {
        rows.push(row); row = [];
        if (char === '\r' && csv[i + 1] === '\n') i++;
      }
    } else if (char === '"') {
      requireThat(field === '' && !closed, 'CSV_SYNTAX', 'A CSV quote must begin a field'); quoted = true;
    } else {
      requireThat(!closed, 'CSV_SYNTAX', 'Unexpected character after a closing CSV quote'); field += char;
    }
  }
  requireThat(!quoted, 'CSV_SYNTAX', 'Unterminated quoted CSV field');
  if (row.length || field !== '' || closed) { row.push(field); rows.push(row); }
  return rows;
}

// Exact integer input only. Conversion of decimal prices, wall-clock timestamps,
// shares, OHLC bars or delayed vendor observations must be explicit upstream.
export function parseQuoteCsv(csv, { instrument, columns, units, idPrefix = 'csv' } = {}) {
  instrumentSpec(instrument);
  requireThat(units && Object.keys(QUOTE_UNITS).every(key => units[key] === QUOTE_UNITS[key]), 'DATA_UNITS', 'Declare units as {time:"ms",price:"quote-minor-per-lot",quantity:"lots"}');
  requireThat(columns && typeof columns === 'object' && !Array.isArray(columns), 'CSV_COLUMNS', 'An explicit field-to-header columns mapping is required');
  const required = ['time', 'bid', 'ask', 'bidLots', 'askLots'];
  const supported = ['id', 'symbol', 'currency', ...quoteFields];
  for (const key of Object.keys(columns)) requireThat(supported.includes(key), 'CSV_COLUMNS', `Unsupported quote field: ${key}`);
  for (const key of required) requireThat(typeof columns[key] === 'string' && columns[key].length > 0, 'CSV_COLUMNS', `Missing column mapping for ${key}`);
  requireThat(new Set(Object.values(columns)).size === Object.values(columns).length, 'CSV_COLUMNS', 'Each quote field must map to a distinct column');
  requireThat(typeof idPrefix === 'string' && idPrefix.length > 0, 'CSV_COLUMNS', 'idPrefix must be nonempty');
  const rows = csvRows(csv);
  requireThat(rows.length > 1, 'CSV_EMPTY', 'CSV must contain a header and at least one quote');
  const [header, ...records] = rows;
  requireThat(header.every(name => name.length > 0) && new Set(header).size === header.length, 'CSV_HEADER', 'CSV headers must be nonempty and unique');
  const indices = Object.fromEntries(Object.entries(columns).map(([field, name]) => {
    requireThat(typeof name === 'string' && header.includes(name), 'CSV_COLUMNS', `Missing CSV header for ${field}: ${name}`);
    return [field, header.indexOf(name)];
  }));
  const ticks = records.map((record, index) => {
    requireThat(record.length === header.length, 'CSV_WIDTH', `CSV data row ${index + 1} has ${record.length} fields; expected ${header.length}`);
    const read = (field, fallback) => Object.hasOwn(indices, field) ? record[indices[field]] : fallback;
    const time = read('time');
    return { id: read('id', `${idPrefix}-${index + 1}`), type: 'tick', symbol: read('symbol', instrument.symbol), currency: read('currency', instrument.currency),
      time, sourceTime: read('sourceTime', time), sequence: read('sequence', String(index + 1)),
      bid: read('bid'), ask: read('ask'), bidLots: read('bidLots'), askLots: read('askLots') };
  });
  return validateTicks(ticks, { instrument });
}

// Xorshift32 + unbiased bounded sampling: deterministic fixtures, not calibrated
// market data. The fixed spread and sampled per-side depth bounds are declared.
export function syntheticQuotes({ instrument, count, seed = '1', startTime = '0', stepMs = '1', initialBid = '100', spreadTicks = '1', volatilityTicks = '1', minLots = '1', maxLots = '10' } = {}) {
  instrumentSpec(instrument);
  requireThat(Number.isSafeInteger(count) && count > 0 && count <= 1_000_000, 'SYNTHETIC_COUNT', 'count must be an integer from 1 to 1,000,000');
  const seedValue = nat(seed, 'seed', true);
  requireThat(seedValue <= 0xffffffffn, 'SYNTHETIC_SEED', 'seed must be in 1..2^32-1');
  let rng = Number(seedValue);
  const next = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return rng >>> 0; };
  const bounded = size => {
    const domain = 1n << 64n, limit = domain - domain % size;
    let sample; do { sample = (BigInt(next()) << 32n) | BigInt(next()); } while (sample >= limit);
    return sample % size;
  };
  const tickSize = BigInt(instrument.priceTick), start = nat(startTime, 'startTime'), step = nat(stepMs, 'stepMs', true);
  const spread = nat(spreadTicks, 'spreadTicks') * tickSize, volatility = nat(volatilityTicks, 'volatilityTicks');
  const lowDepth = nat(minLots, 'minLots'), highDepth = nat(maxLots, 'maxLots');
  let bid = nat(initialBid, 'initialBid', true);
  requireThat(lowDepth <= highDepth && bid % tickSize === 0n, 'SYNTHETIC_CONFIG', 'Depth bounds must be ordered and initialBid must be on tick');
  requireThat(start + BigInt(count - 1) * step <= MAX_NAT && bid + spread <= MAX_NAT, 'INTEGER_RANGE', 'Synthetic quotes exceed supported time or price bounds');
  const ticks = [];
  for (let index = 0; index < count; index++) {
    if (index) {
      bid += (bounded(2n * volatility + 1n) - volatility) * tickSize;
      if (bid < tickSize) bid = tickSize;
    }
    requireThat(bid + spread <= MAX_NAT, 'INTEGER_RANGE', 'Synthetic random walk exceeded the supported price range');
    const time = String(start + BigInt(index) * step);
    ticks.push({ id: `synthetic-${seed}-${index + 1}`, type: 'tick', symbol: instrument.symbol, currency: instrument.currency,
      time, sourceTime: time, sequence: String(index + 1), bid: String(bid), ask: String(bid + spread),
      bidLots: String(lowDepth + bounded(highDepth - lowDepth + 1n)), askLots: String(lowDepth + bounded(highDepth - lowDepth + 1n)) });
  }
  return validateTicks(ticks, { instrument });
}
