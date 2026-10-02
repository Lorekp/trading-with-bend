import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { loadBinanceBars, loadBinanceSeries } from '../../src/binance-bars.mjs';

const HEADER = 'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';
const code = expected => error => error.code === expected;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(csv, { method = 8, descriptor = false, flags = descriptor ? 8 : 0, name = 'ETHUSDT-1m-fixture.csv', trailingDeflateBytes = false } = {}) {
  const source = Buffer.from(csv), filename = Buffer.from(name), crc = crc32(source);
  let payload = method === 0 ? source : deflateRawSync(source);
  if (trailingDeflateBytes) payload = Buffer.concat([payload, Buffer.from([0, 0, 0])]);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
  if (!descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(source.length, 22); }
  local.writeUInt16LE(filename.length, 26);
  const suffix = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
  if (descriptor) { suffix.writeUInt32LE(0x08074b50, 0); suffix.writeUInt32LE(crc, 4); suffix.writeUInt32LE(payload.length, 8); suffix.writeUInt32LE(source.length, 12); }
  const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(payload.length, 20);
  directory.writeUInt32LE(source.length, 24); directory.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + payload.length + suffix.length, 16);
  return Buffer.concat([local, filename, payload, suffix, directory, filename, end]);
}
function row(index, changes = {}) {
  const fields = { time: String(index * 60000), open: '2000.00', high: '2010.00', low: '1990.00', close: `2000.${String(index).padStart(2, '0')}`, volume: '0.0006', closeTime: String(index * 60000 + 59999), quoteVolume: '1000', count: '1', takerVolume: '0', takerQuoteVolume: '0', ignore: '0', ...changes };
  return [fields.time, fields.open, fields.high, fields.low, fields.close, fields.volume, fields.closeTime, fields.quoteVolume, fields.count, fields.takerVolume, fields.takerQuoteVolume, fields.ignore].join(',');
}
const csv = (count = 10) => `${HEADER}\n${Array.from({ length: count }, (_, index) => row(index)).join('\n')}\n`;
function fixture(t, text, { type = 'klines', zipOptions, mutate, expectedSha, expectedBytes, period, date } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bend-binance-e2e-'));
  t.after(() => {
    // Cleanup is confined to the exact temporary directory created by this test.
    assert.equal(resolve(directory, '..'), resolve(tmpdir())); assert.ok(basename(directory).startsWith('bend-binance-e2e-'));
    rmSync(directory, { recursive: true, force: true });
  });
  let archive = makeZip(text, zipOptions); if (mutate) archive = mutate(archive) || archive;
  writeFileSync(join(directory, 'market.zip'), archive);
  const manifest = { symbol: 'ETHUSDT', market: 'USD-M perpetual', month: '1970-01', complete: false, datasets: [
    { type, status: 'complete', files: [{ status: 'verified', path: 'market.zip', bytes: expectedBytes ?? archive.length, sha256: expectedSha ?? sha(archive), ...(period === undefined ? {} : { period }), ...(date === undefined ? {} : { date }) }] },
    { type: 'bookTicker', status: 'incomplete', files: [] },
    { type: 'trades', status: 'complete', files: [{ status: 'verified', path: 'must-never-open-bulk-trades.zip', bytes: 1_200_000_000, sha256: '0'.repeat(64) }] },
  ] };
  const manifestPath = join(directory, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifestPath, archive, manifest };
}

test('verified ZIP -> exact scaling -> completed five-minute bars preserves units and availability', async t => {
  const input = fixture(t, csv()); const result = await loadBinanceBars(input);
  assert.equal(result.bars.length, 2);
  assert.deepEqual(result.bars[0], { openTime: '0', closeTime: '299999', availableAt: '300000', open: '2000000', high: '2010000', low: '1990000', close: '2000040', volumeLots: '3' });
  assert.equal(result.bars[1].volumeLots, '3'); // floor(sum(5 * .0006 ETH) / .001), not sum(floor(.6)).
  assert.equal(result.provenance.sourceRows, 10); assert.equal(result.provenance.sourceMarket, 'USD-M perpetual');
  assert.equal(result.provenance.units.priceTick, '10'); assert.equal(result.provenance.units.lotSizeETH, '0.001');
  assert.equal(result.provenance.executableBidAsk, false); assert.equal(result.provenance.bookTickerAvailableInManifest, false);
  assert.equal(result.provenance.io.bulkTradesRead, false); assert.equal(result.provenance.io.archiveBytesHashed, input.archive.length);
  assert.match(result.provenance.executionUse, /not actual USD-M perpetual returns/);
});
test('stored, deflated, UTF-8 and data-descriptor ZIP entries are streamed correctly', async t => {
  for (const zipOptions of [{ method: 0 }, { method: 8 }, { method: 8, flags: 0x800 }, { method: 8, descriptor: true }]) {
    const input = fixture(t, csv(), { zipOptions });
    const result = await loadBinanceBars({ manifestPath: input.manifestPath, intervalMinutes: 1 });
    assert.equal(result.bars.length, 10); assert.equal(result.bars[0].volumeLots, '0');
  }
});
test('selection is UTC aligned and never includes an incomplete or future five-minute bar', async t => {
  const full = fixture(t, csv()), prefix = fixture(t, csv(6));
  const all = await loadBinanceBars(full), partial = await loadBinanceBars(prefix);
  assert.deepEqual(partial.bars, [all.bars[0]]); assert.equal(partial.provenance.incompleteGroupsDropped, 1);
  assert.deepEqual((await loadBinanceBars({ ...full, startTime: '60000', endTime: '600000' })).bars, [all.bars[1]]);
  assert.deepEqual((await loadBinanceBars({ ...full, endTime: '300000' })).bars, [all.bars[0]]);
  await assert.rejects(loadBinanceBars({ ...full, endTime: '299999' }), code('BINANCE_RANGE'));
  await assert.rejects(loadBinanceBars({ ...full, startTime: '1', endTime: '300000' }), code('BINANCE_RANGE'));
  await assert.rejects(loadBinanceBars(fixture(t, csv(4))), code('BINANCE_RANGE'));
  await assert.rejects(loadBinanceBars({ ...full, intervalMinutes: 7 }), code('BAR_INTERVAL'));
});
test('archive SHA-256 and byte count are verified through the existing Bend gate', async t => {
  await assert.rejects(loadBinanceBars(fixture(t, csv(), { expectedSha: '0'.repeat(64) })), code('ARCHIVE_INTEGRITY'));
  await assert.rejects(loadBinanceBars(fixture(t, csv(), { expectedBytes: 1 })), code('ARCHIVE_INTEGRITY'));
});
test('resampling spans file boundaries while chronology remains continuous across archives', async t => {
  const input = fixture(t, csv(3));
  const append = start => {
    const archive = makeZip(`${HEADER}\n${Array.from({ length: 10 - start }, (_, index) => row(index + start)).join('\n')}\n`);
    writeFileSync(join(dirname(input.manifestPath), 'second.zip'), archive);
    input.manifest.datasets[0].files = [input.manifest.datasets[0].files[0], { status: 'verified', path: 'second.zip', bytes: String(archive.length), sha256: sha(archive) }];
    writeFileSync(input.manifestPath, JSON.stringify(input.manifest));
  };
  append(3);
  const result = await loadBinanceBars(input);
  assert.equal(result.bars.length, 2); assert.equal(result.bars[0].volumeLots, '3');
  assert.equal(result.provenance.archives.length, 2); assert.equal(result.provenance.sourceRows, 10);
  append(4); await assert.rejects(loadBinanceBars(input), code('BAR_CONTIGUITY'));
});
test('ZIP corruption, unsupported flags/methods, CRC errors and decompression size lies fail closed', async t => {
  const centralOffset = archive => archive.readUInt32LE(archive.length - 6);
  for (const [options, expected] of [
    [{ zipOptions: { flags: 1 } }, 'ZIP_UNSUPPORTED'],
    [{ zipOptions: { method: 99 } }, 'ZIP_UNSUPPORTED'],
    [{ zipOptions: { name: '../market.csv' } }, 'ZIP_UNSUPPORTED'],
    [{ zipOptions: { trailingDeflateBytes: true } }, 'ZIP_STRUCTURE'],
    [{ mutate: archive => { archive.writeUInt16LE(2, archive.length - 12); } }, 'ZIP_UNSUPPORTED'],
    [{ mutate: archive => { const offset = centralOffset(archive); archive.writeUInt32LE(0, 14); archive.writeUInt32LE(0, offset + 16); } }, 'ZIP_CRC'],
    [{ mutate: archive => { const offset = centralOffset(archive); archive.writeUInt32LE(1, 22); archive.writeUInt32LE(1, offset + 24); } }, 'ZIP_SIZE'],
    [{ mutate: archive => archive.subarray(0, archive.length - 1) }, 'ZIP_STRUCTURE'],
  ]) await assert.rejects(loadBinanceBars(fixture(t, csv(), options)), code(expected));
});
test('minute chronology, OHLC, volumes and price precision are checked before data can escape', async t => {
  const invalid = [
    [[row(0), row(2)], 'BAR_CONTIGUITY'], [[row(0), row(0)], 'BAR_CONTIGUITY'], [[row(1), row(0)], 'BAR_CONTIGUITY'],
    [[row(0, { closeTime: '60000' })], 'BAR_INTERVAL'], [[row(0, { low: '2001.00' })], 'BAR_OHLC'],
    [[row(0, { open: '2000.001' })], 'PRICE_TICK'], [[row(0, { open: '2000.0001' })], 'BINANCE_PRECISION'],
    [[row(0, { volume: '-1' })], 'BINANCE_DECIMAL'], [[row(0, { takerVolume: '1' })], 'BAR_VOLUME'],
  ];
  for (const [rows, expected] of invalid) {
    const input = fixture(t, `${HEADER}\n${rows.join('\n')}\n`);
    await assert.rejects(loadBinanceBars({ ...input, intervalMinutes: 1 }), code(expected));
  }
  await assert.rejects(loadBinanceBars(fixture(t, `wrong-header\n${row(0)}\n`)), code('BINANCE_CSV_HEADER'));
  await assert.rejects(loadBinanceBars(fixture(t, `${HEADER}\n`)), code('BINANCE_CSV'));
});
test('declared daily archives require complete UTC coverage including leap days', async t => {
  const calendarRows = (start, count) => `${HEADER}\n${Array.from({ length: count }, (_, index) => row(index, { time: String(start + index * 60000), closeTime: String(start + index * 60000 + 59999), close: '2001.00' })).join('\n')}\n`;
  for (const date of ['1970-01-01', '2024-02-29']) {
    const start = Date.parse(`${date}T00:00:00.000Z`), input = fixture(t, calendarRows(start, 1440), { period: 'daily', date });
    const result = await loadBinanceBars(input), coverage = result.provenance.archives[0].coverage;
    assert.equal(result.bars.length, 288); assert.equal(coverage.status, 'complete-declared-calendar-period');
    assert.equal(coverage.declared.expectedMinuteRows, '1440'); assert.equal(coverage.observed.startTime, String(start));
    assert.equal(coverage.observed.endTime, String(start + 86400000));
  }
  for (const [start, count] of [[0, 1439], [60000, 1440]]) {
    const input = fixture(t, calendarRows(start, count), { period: 'daily', date: '1970-01-01' });
    await assert.rejects(loadBinanceBars(input), code('ARCHIVE_COVERAGE'));
  }
});
test('monthly declarations reject verified contiguous fragments while undeclared fixtures remain observed-only', async t => {
  const partial = fixture(t, csv());
  assert.equal((await loadBinanceBars(partial)).provenance.archives[0].coverage.status, 'observed-only');
  const monthly = fixture(t, csv(), { period: 'monthly', date: '1970-01' });
  await assert.rejects(loadBinanceBars(monthly), code('ARCHIVE_COVERAGE'));
  const result = await loadBinanceBars({ ...partial, startTime: '0', endTime: '86400000' });
  assert.equal(result.bars.length, 2); assert.equal(result.provenance.sourceEndTime, '600000');
  assert.equal(result.provenance.selection.policy, 'intersection-with-observed-source-coverage');
});
test('calendar metadata rejects nonexistent dates, overflow normalization, incomplete metadata and unknown periods', async t => {
  for (const metadata of [
    { period: 'daily', date: '2026-02-30' }, { period: 'daily', date: '2025-02-29' },
    { period: 'daily', date: '2026-13-01' }, { period: 'daily', date: '2026-00-01' },
    { period: 'daily', date: '2026-9-01' }, { period: 'monthly', date: '2026-13' },
    { period: 'monthly', date: '1969-12' }, { period: 'monthly', date: '2026-09-01' },
    { period: 'monthly' }, { date: '2026-09' }, { period: 'weekly', date: '2026-09-01' },
  ]) await assert.rejects(loadBinanceBars(fixture(t, csv(), metadata)), code('ARCHIVE_PERIOD'));
});
test('auxiliary mark/index/premium series retain exact signed eight-decimal units', async t => {
  for (const type of ['markPriceKlines', 'indexPriceKlines']) {
    const input = fixture(t, `${HEADER}\n${row(0, { open: '2000.12345678', close: '2000.12345678', volume: '0' })}\n`, { type });
    const result = await loadBinanceSeries({ ...input, type });
    assert.equal(result.rows[0].open, '200012345678'); assert.equal(result.rows[0].availableAt, '60000');
    assert.equal(result.provenance.executableBidAsk, false);
  }
  const type = 'premiumIndexKlines';
  const input = fixture(t, `${HEADER}\n${row(0, { open: '-0.00065828', high: '-0.00047762', low: '-0.00065828', close: '-0.00056673', volume: '0' })}\n`, { type });
  const result = await loadBinanceSeries({ ...input, type });
  assert.equal(result.rows[0].open, '-65828'); assert.equal(result.rows[0].close, '-56673');
});
test('funding exact scientific decimals, chronology and exclusive end selection are explicit', async t => {
  const type = 'fundingRate', input = fixture(t, 'calc_time,funding_interval_hours,last_funding_rate\n0,8,9.2E-7\n28800000,8,-0.00010000\n', { type });
  const result = await loadBinanceSeries({ ...input, type });
  assert.deepEqual(result.rows, [{ time: '0', availableAt: '0', fundingIntervalHours: '8', rate: '92' }, { time: '28800000', availableAt: '28800000', fundingIntervalHours: '8', rate: '-10000' }]);
  assert.equal((await loadBinanceSeries({ ...input, type, endTime: '28800000' })).rows.length, 1);
  await assert.rejects(loadBinanceSeries({ ...fixture(t, 'calc_time,funding_interval_hours,last_funding_rate\n0,8,0.01\n0,8,0.01\n', { type }), type }), code('BAR_CONTIGUITY'));
  const monthly = fixture(t, 'calc_time,funding_interval_hours,last_funding_rate\n5,8,9.2E-7\n28800001,8,0.0001\n', { type, period: 'monthly', date: '1970-01' });
  const observed = await loadBinanceSeries({ ...monthly, type });
  assert.equal(observed.provenance.archives[0].coverage.status, 'observed-only');
  assert.equal(observed.provenance.archives[0].coverage.observed.startTime, '5');
  assert.equal(observed.provenance.archives[0].coverage.declared.expectedMinuteRows, undefined);
  await assert.rejects(loadBinanceSeries({ ...fixture(t, 'calc_time,funding_interval_hours,last_funding_rate\n5,8,0.0001\n', { type, period: 'monthly', date: '1970-13' }), type }), code('ARCHIVE_PERIOD'));
});

test('downloaded September ETHUSDT archives verify, stream and resample without loading bulk trades', { skip: process.env.BINANCE_REAL_DATA !== '1' }, async () => {
  const manifestPath = fileURLToPath(new URL('../../data/binance/um/ETHUSDT/2026-09/manifest.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const result = await loadBinanceBars({ manifestPath });
  assert.equal(result.provenance.sourceRows, 43200); assert.equal(result.bars.length, 8640);
  assert.equal(result.bars[0].open, '2466520'); assert.equal(result.bars[0].close, '2466490'); assert.equal(result.bars[0].volumeLots, '4642910');
  assert.equal(result.bars.at(-1).availableAt, '1790812800000');
  assert.equal(result.provenance.io.archiveBytesHashed, manifest.datasets.find(dataset => dataset.type === 'klines').files[0].bytes);
  assert.equal(result.provenance.archives[0].coverage.status, 'complete-declared-calendar-period');
  assert.equal(result.provenance.archives[0].coverage.declared.expectedMinuteRows, '43200');
  for (const type of ['markPriceKlines', 'indexPriceKlines', 'premiumIndexKlines', 'fundingRate']) {
    const auxiliary = await loadBinanceSeries({ manifestPath, type });
    assert.equal(auxiliary.rows.length, type === 'fundingRate' ? 90 : 43200);
    assert.equal(auxiliary.provenance.archives[0].coverage.status, type === 'fundingRate' ? 'observed-only' : 'complete-declared-calendar-period');
  }
});
