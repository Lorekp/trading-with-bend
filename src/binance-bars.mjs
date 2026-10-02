import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { archiveAccepted, checkArchiveBuild } from './archive.mjs';
import { hash, MAX_NAT, nat, requireThat } from './framework.mjs';

const MINUTE = 60_000n;
const KLINE_HEADER = 'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';
const FUNDING_HEADER = 'calc_time,funding_interval_hours,last_funding_rate';
const AUXILIARY = ['markPriceKlines', 'indexPriceKlines', 'premiumIndexKlines', 'fundingRate'];
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024, MAX_CSV_BYTES = 128 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crcUpdate = (crc, bytes) => { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc >>> 0; };
const fail = (ok, code, message) => requireThat(ok, code, message);

async function readExactly(handle, position, length) {
  const bytes = Buffer.alloc(length); let read = 0;
  while (read < length) {
    const result = await handle.read(bytes, read, length - read, position + read);
    fail(result.bytesRead > 0, 'ZIP_STRUCTURE', 'Truncated ZIP structure'); read += result.bytesRead;
  }
  return bytes;
}
function validateExtra(extra) {
  let offset = 0;
  while (offset < extra.length) {
    fail(offset + 4 <= extra.length, 'ZIP_STRUCTURE', 'Truncated ZIP extra field');
    const kind = extra.readUInt16LE(offset), length = extra.readUInt16LE(offset + 2);
    fail(kind !== 1, 'ZIP_UNSUPPORTED', 'ZIP64 archives are unsupported');
    offset += 4 + length;
    fail(offset <= extra.length, 'ZIP_STRUCTURE', 'Invalid ZIP extra field length');
  }
}

// No extraction to disk and no whole-CSV buffer. Central and local headers are
// cross-checked; only one ordinary, nonencrypted CSV entry is supported.
async function inspectZip(handle, size) {
  fail(size >= 22 && size <= MAX_ARCHIVE_BYTES, 'ZIP_SIZE', 'Small-data ZIP must be between 22 bytes and 64 MiB');
  const tailLength = Math.min(size, 65557), tail = await readExactly(handle, size - tailLength, tailLength);
  let end = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { end = offset; break; }
  }
  fail(end >= 0, 'ZIP_STRUCTURE', 'ZIP end-of-central-directory record is missing');
  fail(tail.readUInt16LE(end + 4) === 0 && tail.readUInt16LE(end + 6) === 0 && tail.readUInt16LE(end + 8) === 1 && tail.readUInt16LE(end + 10) === 1,
    'ZIP_UNSUPPORTED', 'Require a single CSV in a single-disk ZIP');
  const centralSize = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16), endOffset = size - tailLength + end;
  fail(centralSize >= 46 && centralSize <= 196651 && centralOffset + centralSize === endOffset, 'ZIP_STRUCTURE', 'ZIP central directory bounds are invalid');
  const central = await readExactly(handle, centralOffset, centralSize);
  fail(central.readUInt32LE(0) === 0x02014b50, 'ZIP_STRUCTURE', 'Missing ZIP central file header');
  const version = central.readUInt16LE(6), flags = central.readUInt16LE(8), method = central.readUInt16LE(10);
  const crc = central.readUInt32LE(16), compressed = central.readUInt32LE(20), uncompressed = central.readUInt32LE(24);
  const nameLength = central.readUInt16LE(28), extraLength = central.readUInt16LE(30), commentLength = central.readUInt16LE(32), localOffset = central.readUInt32LE(42);
  fail(version <= 20 && (flags & ~0x808) === 0 && [0, 8].includes(method) && central.readUInt16LE(34) === 0,
    'ZIP_UNSUPPORTED', 'Only stored/deflated nonencrypted ZIP entries with optional UTF-8/data-descriptor flags are supported');
  fail(46 + nameLength + extraLength + commentLength === central.length && localOffset === 0, 'ZIP_STRUCTURE', 'Unexpected ZIP entries or prefix');
  fail(compressed > 0 && compressed !== 0xffffffff && uncompressed > 0 && uncompressed <= MAX_CSV_BYTES, 'ZIP_SIZE', 'CSV size is invalid or exceeds 128 MiB');
  fail(method !== 0 || compressed === uncompressed, 'ZIP_STRUCTURE', 'Stored ZIP sizes must agree');
  const nameBytes = central.subarray(46, 46 + nameLength), name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
  fail(/^[A-Za-z0-9._-]+\.csv$/.test(name), 'ZIP_UNSUPPORTED', 'ZIP entry must be a single root-level CSV');
  validateExtra(central.subarray(46 + nameLength, 46 + nameLength + extraLength));
  const local = await readExactly(handle, localOffset, 30);
  fail(local.readUInt32LE(0) === 0x04034b50 && local.readUInt16LE(4) === version && local.readUInt16LE(6) === flags && local.readUInt16LE(8) === method,
    'ZIP_STRUCTURE', 'ZIP local and central headers differ');
  const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
  const variable = await readExactly(handle, 30, localNameLength + localExtraLength);
  fail(localNameLength === nameLength && variable.subarray(0, localNameLength).equals(nameBytes), 'ZIP_STRUCTURE', 'ZIP entry names differ');
  validateExtra(variable.subarray(localNameLength));
  const dataStart = 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressed;
  fail(dataEnd <= centralOffset, 'ZIP_STRUCTURE', 'Compressed ZIP data overlaps the central directory');
  if (flags & 8) {
    for (const [offset, expected] of [[14, crc], [18, compressed], [22, uncompressed]]) fail([0, expected].includes(local.readUInt32LE(offset)), 'ZIP_STRUCTURE', 'Invalid data-descriptor local size/CRC');
    const descriptorLength = centralOffset - dataEnd;
    fail([12, 16].includes(descriptorLength), 'ZIP_STRUCTURE', 'Invalid ZIP data descriptor length');
    const descriptor = await readExactly(handle, dataEnd, descriptorLength), base = descriptorLength === 16 ? 4 : 0;
    fail(base === 0 || descriptor.readUInt32LE(0) === 0x08074b50, 'ZIP_STRUCTURE', 'Invalid ZIP data descriptor signature');
    fail(descriptor.readUInt32LE(base) === crc && descriptor.readUInt32LE(base + 4) === compressed && descriptor.readUInt32LE(base + 8) === uncompressed,
      'ZIP_STRUCTURE', 'ZIP data descriptor differs from its central header');
  } else {
    fail(dataEnd === centralOffset && local.readUInt32LE(14) === crc && local.readUInt32LE(18) === compressed && local.readUInt32LE(22) === uncompressed,
      'ZIP_STRUCTURE', 'ZIP local sizes/CRC differ or undeclared records exist');
  }
  return { name, method, crc, compressed, uncompressed, dataStart, dataEnd };
}

async function consumeArchive(file, manifestDirectory, onLine) {
  fail(file.status === 'verified' && typeof file.path === 'string' && /^[a-f0-9]{64}$/i.test(file.sha256), 'BINANCE_MANIFEST', 'Selected archives require verified status, path and SHA-256');
  fail((Number.isSafeInteger(file.bytes) && file.bytes > 0) || (typeof file.bytes === 'string' && /^[1-9][0-9]*$/.test(file.bytes)), 'BINANCE_MANIFEST', 'Selected archive byte size is required');
  const path = resolve(manifestDirectory, file.path), handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    fail(stat.isFile() && stat.size <= MAX_ARCHIVE_BYTES, 'ZIP_SIZE', 'This adapter accepts only small regular-file archives, never bulk trades');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) digest.update(chunk);
    const actual = digest.digest('hex');
    fail(archiveAccepted(file.sha256, actual, BigInt(file.bytes), BigInt(stat.size)), 'ARCHIVE_INTEGRITY', `SHA-256 or size mismatch: ${path}`);
    const entry = await inspectZip(handle, stat.size);
    const input = handle.createReadStream({ start: entry.dataStart, end: entry.dataEnd - 1, autoClose: false });
    const payload = entry.method === 8 ? input.pipe(createInflateRaw()) : input;
    if (payload !== input) input.on('error', error => payload.destroy(error));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let outputSize = 0, crc = 0xffffffff, pending = '', lines = 0;
    const line = text => { fail(text.length <= 4096, 'BINANCE_CSV', 'CSV line exceeds the supported numeric schema'); onLine(text.endsWith('\r') ? text.slice(0, -1) : text, ++lines); };
    try {
      for await (const chunk of payload) {
        outputSize += chunk.length;
        fail(outputSize <= entry.uncompressed, 'ZIP_SIZE', 'Inflated CSV exceeds its declared size');
        crc = crcUpdate(crc, chunk); pending += decoder.decode(chunk, { stream: true });
        let start = 0, boundary;
        while ((boundary = pending.indexOf('\n', start)) >= 0) { line(pending.slice(start, boundary)); start = boundary + 1; }
        pending = pending.slice(start);
        fail(pending.length <= 4096, 'BINANCE_CSV', 'CSV line exceeds the supported numeric schema');
      }
      pending += decoder.decode(); if (pending.length) line(pending);
      fail(outputSize === entry.uncompressed && input.bytesRead === entry.compressed, 'ZIP_SIZE', 'ZIP payload length differs from its declared size');
      fail(entry.method !== 8 || payload.bytesWritten === entry.compressed, 'ZIP_STRUCTURE', 'Unused bytes follow the deflated stream');
      fail(((crc ^ 0xffffffff) >>> 0) === entry.crc, 'ZIP_CRC', 'CSV CRC-32 differs from the ZIP directory');
      const after = await handle.stat();
      fail(after.size === stat.size && after.mtimeMs === stat.mtimeMs, 'ARCHIVE_INTEGRITY', 'Archive changed while being read');
      return { path, sha256: actual, bytes: stat.size, entry: entry.name, compressedBytes: entry.compressed, uncompressedBytes: entry.uncompressed, rows: lines - 1 };
    } finally { payload.destroy(); if (payload !== input) input.destroy(); }
  } finally { await handle.close(); }
}

function decimal(value, name, signed = false) {
  const match = typeof value === 'string' && value.length <= 64 && /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?(?:0|[1-9][0-9]*)))?$/.exec(value);
  fail(match && (signed || match[1] === ''), 'BINANCE_DECIMAL', `${name} must be an exact ${signed ? 'signed' : 'nonnegative'} decimal`);
  const [, sign, integer, fraction = '', exponentText = '0'] = match, exponent = Number(exponentText);
  fail(fraction.length <= 18 && Number.isSafeInteger(exponent) && Math.abs(exponent) <= 18, 'BINANCE_DECIMAL', `${name} exceeds the supported decimal precision/exponent`);
  const power = fraction.length - exponent;
  // Binance funding archives include literals such as 9.2E-7. The conversion
  // never passes the coefficient through floating point.
  return { numerator: BigInt(integer + fraction) * (sign === '-' ? -1n : 1n) * (power < 0 ? 10n ** BigInt(-power) : 1n), denominator: power > 0 ? 10n ** BigInt(power) : 1n };
}
function scaled(value, scale, name, signed = false) {
  const number = decimal(value, name, signed), numerator = number.numerator * scale;
  fail(numerator % number.denominator === 0n, 'BINANCE_PRECISION', `${name} cannot be represented exactly in the declared units`);
  const result = numerator / number.denominator;
  fail(result >= -MAX_NAT && result <= MAX_NAT, 'INTEGER_RANGE', `${name} exceeds supported integer range`);
  return result;
}
const decimalAtMost = (left, right) => left.numerator * right.denominator <= right.numerator * left.denominator;

function kline(fields, type) {
  fail(fields.length === 12, 'BINANCE_CSV', 'Kline rows require exactly 12 fields');
  const openTime = nat(fields[0], 'open_time'), closeTime = nat(fields[6], 'close_time');
  fail(openTime % MINUTE === 0n && closeTime === openTime + MINUTE - 1n && closeTime < MAX_NAT, 'BAR_INTERVAL', 'Require complete UTC-aligned one-minute bars');
  const premium = type === 'premiumIndexKlines', unit = type === 'klines' ? 1000n : 100_000_000n;
  const [open, high, low, close] = fields.slice(1, 5).map((value, index) => scaled(value, unit, ['open', 'high', 'low', 'close'][index], premium));
  fail((premium || low > 0n) && low <= open && low <= close && high >= open && high >= close && high >= low, 'BAR_OHLC', 'Kline prices violate OHLC bounds');
  if (type === 'klines') fail([open, high, low, close].every(value => value % 10n === 0n), 'PRICE_TICK', 'ETHUSDT trade bars must lie on the declared microUSDT-per-lot tick of 10');
  const volumeAtoms = scaled(fields[5], 100_000_000n, 'volume');
  const quoteVolume = decimal(fields[7], 'quote_volume'), takerVolume = decimal(fields[9], 'taker_buy_volume'), takerQuote = decimal(fields[10], 'taker_buy_quote_volume');
  nat(fields[8], 'count'); decimal(fields[11], 'ignore');
  fail(decimalAtMost(takerVolume, decimal(fields[5], 'volume')) && decimalAtMost(takerQuote, quoteVolume), 'BAR_VOLUME', 'Taker volume exceeds total volume');
  return { openTime, closeTime, availableAt: closeTime + 1n, open, high, low, close, volumeAtoms };
}
function funding(fields) {
  fail(fields.length === 3, 'BINANCE_CSV', 'Funding rows require exactly 3 fields');
  const time = nat(fields[0], 'calc_time'), interval = nat(fields[1], 'funding_interval_hours', true), rate = scaled(fields[2], 100_000_000n, 'last_funding_rate', true);
  return { time, availableAt: time, fundingIntervalHours: interval, rate };
}
function bounds(startTime, endTime) {
  const start = startTime === undefined ? 0n : nat(startTime, 'startTime'), end = endTime === undefined ? MAX_NAT : nat(endTime, 'endTime');
  fail(start < end, 'BINANCE_RANGE', 'Require startTime < endTime'); return { start, end };
}
const strings = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));

function declaredPeriod(file) {
  if (file.period === undefined && file.date === undefined) return null;
  fail(['monthly', 'daily'].includes(file.period) && typeof file.date === 'string', 'ARCHIVE_PERIOD', 'Archive period/date must both be supplied as monthly YYYY-MM or daily YYYY-MM-DD');
  const monthly = file.period === 'monthly';
  fail((monthly ? /^[0-9]{4}-(0[1-9]|1[0-2])$/ : /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/).test(file.date),
    'ARCHIVE_PERIOD', 'Archive date must use the exact declared UTC calendar format');
  const day = monthly ? `${file.date}-01` : file.date, milliseconds = Date.parse(`${day}T00:00:00.000Z`);
  // Date.parse normalizes some invalid dates (e.g. February 30); a round trip
  // is required. Four-digit years >=1970 also fit the bounded integer domain.
  fail(Number.isSafeInteger(milliseconds) && milliseconds >= 0 && new Date(milliseconds).toISOString().slice(0, 10) === day,
    'ARCHIVE_PERIOD', 'Archive date is not a valid nonnegative UTC calendar date');
  const next = new Date(milliseconds);
  if (monthly) next.setUTCMonth(next.getUTCMonth() + 1); else next.setUTCDate(next.getUTCDate() + 1);
  const start = nat(String(milliseconds), 'archive period start'), end = nat(String(next.getTime()), 'archive period end');
  return { period: file.period, date: file.date, start, end, minuteRows: (end - start) / MINUTE };
}

async function records({ manifestPath, type, startTime, endTime }, consume) {
  fail(typeof manifestPath === 'string' && ['klines', ...AUXILIARY].includes(type), 'BINANCE_ARGUMENT', 'A manifestPath and a supported small dataset type are required');
  const selection = bounds(startTime, endTime), manifestText = await readFile(manifestPath, 'utf8'), manifest = JSON.parse(manifestText);
  fail(manifest.symbol === 'ETHUSDT' && manifest.market === 'USD-M perpetual' && Array.isArray(manifest.datasets), 'BINANCE_MANIFEST', 'Require the ETHUSDT USD-M perpetual archive manifest');
  const datasets = manifest.datasets.filter(dataset => dataset.type === type);
  fail(datasets.length === 1 && datasets[0].status === 'complete' && Array.isArray(datasets[0].files) && datasets[0].files.length > 0, 'BINANCE_MANIFEST', 'Requested dataset must have one complete file list');
  checkArchiveBuild();
  const archives = []; let previous = null, sourceRows = 0, sourceStart = null, sourceEnd = null;
  for (const file of datasets[0].files) {
    const period = declaredPeriod(file);
    let fileRows = 0, fileStart = null, fileEnd = null;
    const metadata = await consumeArchive(file, dirname(resolve(manifestPath)), (line, lineNumber) => {
      if (lineNumber === 1) { fail(line === (type === 'fundingRate' ? FUNDING_HEADER : KLINE_HEADER), 'BINANCE_CSV_HEADER', 'CSV header differs from the declared Binance schema'); return; }
      fail(line.length > 0, 'BINANCE_CSV', 'Empty rows are not market observations');
      const record = type === 'fundingRate' ? funding(line.split(',')) : kline(line.split(','), type);
      const time = type === 'fundingRate' ? record.time : record.openTime;
      fail(previous === null || (type === 'fundingRate' ? time > previous : time === previous + MINUTE), 'BAR_CONTIGUITY', 'Archive observations must be ordered, unique, and minute bars strictly contiguous; data is never sorted');
      previous = time; sourceStart ??= time; sourceEnd = record.availableAt; sourceRows++; fileRows++;
      fileStart ??= time; fileEnd = record.availableAt;
      consume(record, selection);
    });
    fail(fileRows > 0, 'BINANCE_CSV', 'Archive must contain data rows');
    const completePeriod = period !== null && type !== 'fundingRate';
    if (completePeriod) fail(fileStart === period.start && fileEnd === period.end && BigInt(fileRows) === period.minuteRows,
      'ARCHIVE_COVERAGE', `Declared ${period.period} ${period.date} archive must cover its full UTC interval with exactly ${period.minuteRows} minute rows`);
    archives.push({ ...metadata, coverage: {
      status: completePeriod ? 'complete-declared-calendar-period' : 'observed-only',
      declared: period === null ? null : { period: period.period, date: period.date, startTime: String(period.start), endTime: String(period.end), ...(type === 'fundingRate' ? {} : { expectedMinuteRows: String(period.minuteRows) }) },
      observed: { startTime: String(fileStart), endTime: String(fileEnd), rows: fileRows },
      ...(type === 'fundingRate' ? { reason: 'Funding events are observations; timestamp jitter and variable funding intervals do not establish full calendar coverage' } : period === null ? { reason: 'Archive has no declared period/date; only observed chronology is established' } : {}),
    } });
  }
  const book = manifest.datasets.find(dataset => dataset.type === 'bookTicker');
  return {
    format: 'binance-small-data-v1', symbol: manifest.symbol, sourceMarket: manifest.market, sourceMonth: manifest.month,
    dataset: type, manifestHash: hash(manifestText), archives, sourceRows, sourceStartTime: String(sourceStart), sourceEndTime: String(sourceEnd),
    selection: { startTime: startTime ?? null, endTime: endTime ?? null, policy: 'intersection-with-observed-source-coverage' },
    archiveVerification: 'SHA-256 and byte length accepted by Bend Archive policy; ZIP sizes and CRC-32 checked',
    bookTickerAvailableInManifest: book?.status === 'complete' && book.files?.some(file => file.status === 'verified') || false,
    bookTickerLoaded: false, executableBidAsk: false,
    availabilityAssumption: type === 'fundingRate' ? 'calc_time; historical archive does not certify publication or observation latency' : 'close_time + 1 millisecond; historical archive does not certify publication or observation latency',
    executionUse: 'Cash-spot price proxy for framework validation only; not actual USD-M perpetual returns',
    limitations: ['No executable bid/ask bookTicker is loaded; OHLCV cannot establish fills or quoted liquidity.', 'A cash-spot proxy does not model perpetual margin, leverage, liquidation, contract settlement or funding cashflows.'],
    io: { archiveBytesHashed: archives.reduce((total, archive) => total + archive.bytes, 0), csvBytesInflated: archives.reduce((total, archive) => total + archive.uncompressedBytes, 0), bulkTradesRead: false },
  };
}

/** Canonical completed OHLCV bars. Price = USDT/ETH * 1000, i.e. microUSDT
 * per 0.001 ETH lot. Volume is floored only after summing minute ETH volumes.
 * Bounds use UTC epoch milliseconds: open >= start and availability <= end.
 * They select an intersection with observed coverage, rather than asserting
 * that the source contains either requested endpoint. Declared monthly/daily
 * kline files must themselves cover their complete UTC calendar interval.
 */
export async function loadBinanceBars({ manifestPath, intervalMinutes = 5, startTime, endTime } = {}) {
  fail(Number.isSafeInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 1440 && 1440 % intervalMinutes === 0,
    'BAR_INTERVAL', 'intervalMinutes must be a positive divisor of 1440');
  const interval = BigInt(intervalMinutes) * MINUTE, bars = []; let pending = null, incompleteGroups = 0;
  const finish = selection => {
    if (!pending) return;
    if (pending.count !== intervalMinutes || pending.openTime !== pending.bucket || pending.availableAt !== pending.bucket + interval) { incompleteGroups++; return; }
    if (pending.openTime >= selection.start && pending.availableAt <= selection.end) {
      const { count, bucket, volumeAtoms, ...bar } = pending;
      const volumeLots = volumeAtoms / 100_000n;
      fail(volumeLots <= MAX_NAT, 'INTEGER_RANGE', 'Resampled volume exceeds supported lot range');
      bars.push(strings({ ...bar, volumeLots }));
    }
  };
  let selection;
  const provenance = await records({ manifestPath, type: 'klines', startTime, endTime }, (record, range) => {
    selection = range;
    const bucket = record.openTime - record.openTime % interval;
    if (!pending || pending.bucket !== bucket) { finish(range); pending = { ...record, bucket, count: 1 }; }
    else {
      pending.high = pending.high > record.high ? pending.high : record.high;
      pending.low = pending.low < record.low ? pending.low : record.low;
      pending.close = record.close; pending.closeTime = record.closeTime; pending.availableAt = record.availableAt;
      pending.volumeAtoms += record.volumeAtoms; pending.count++;
    }
  });
  finish(selection);
  fail(bars.length > 0, 'BINANCE_RANGE', 'No complete bars fall inside the requested bounds');
  return { bars, provenance: { ...provenance, intervalMinutes, sourceIntervalMinutes: 1, incompleteGroupsDropped: incompleteGroups, selectedBars: bars.length,
    units: { cash: 'microUSDT', price: 'microUSDT per 0.001 ETH lot', lotSizeETH: '0.001', priceTick: '10', volumeLots: 'whole 0.001 ETH lots; floor after aggregating exact ETH volume' } } };
}

/** Auxiliary observations remain exact and carry availability. Mark/index
 * prices and signed premium/funding rates use scale 1e8; they are not quotes.
 */
export async function loadBinanceSeries({ manifestPath, type, startTime, endTime } = {}) {
  fail(AUXILIARY.includes(type), 'BINANCE_ARGUMENT', 'Auxiliary type must be markPriceKlines, indexPriceKlines, premiumIndexKlines or fundingRate');
  const rows = [];
  const provenance = await records({ manifestPath, type, startTime, endTime }, (record, selection) => {
    const time = type === 'fundingRate' ? record.time : record.openTime;
    if (time >= selection.start && time < selection.end && record.availableAt <= selection.end) {
      const { volumeAtoms, ...row } = record; rows.push(strings(row));
    }
  });
  fail(rows.length > 0, 'BINANCE_RANGE', 'No auxiliary observations fall inside the requested bounds');
  return { rows, provenance: { ...provenance, units: type === 'fundingRate'
    ? { rate: 'signed funding fraction multiplied by 100000000', fundingIntervalHours: 'hours' }
    : { price: type === 'premiumIndexKlines' ? 'signed premium fraction multiplied by 100000000' : 'USDT per ETH multiplied by 100000000' } } };
}
