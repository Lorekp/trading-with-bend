import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { openMarketSource } from '../../src/market-source.mjs';
import { prepareMarketData, readProcessedData, loadProcessedInformationSource, asOfMarketData } from '../../src/market-data.mjs';
import { prepareInformationSource, openPreparedInformationSource } from '../../src/information-source.mjs';
import { QuoteExecutionVenue } from '../../src/execution-venue.mjs';
import { runStrategy } from '../../src/replay.mjs';
import { mkdirSync } from 'node:fs';
import { loadBinanceBars, loadBinanceSeries } from '../../src/binance-bars.mjs';
import { downloadHyperliquid, monthWindow, candleCoverage, validateFunding } from '../../scripts/download-hyperliquid.mjs';

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

test('matching Hyperliquid acquisition preserves raw evidence, paginates funding and exposes missing execution data', async t => {
  const input = fixture(t, csv());
  input.manifest.month = '2024-09';
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest));
  const root = join(dirname(input.manifestPath), 'hyperliquid'), window = monthWindow('2024-09');
  const funding = Array.from({ length: 720 }, (_, index) => ({ coin: 'ETH', time: window.startTime + index * 3_600_000, fundingRate: '-0.00001', premium: '0.00002' }));
  const requests = [];
  const result = await downloadHyperliquid({ binanceManifest: input.manifestPath, root, request: async body => {
    requests.push(body);
    if (body.type === 'fundingHistory') return JSON.stringify(funding.filter(row => row.time >= body.startTime).slice(0, 500));
    if (body.type === 'metaAndAssetCtxs') return JSON.stringify([{ universe: [{ name: 'ETH', szDecimals: 4 }] }, [{ markPx: '2000' }]]);
    const intervalMs = { '1m': 60_000, '5m': 300_000, '15m': 900_000 }[body.req.interval];
    const count = body.req.interval === '15m' ? 2880 : 2;
    return JSON.stringify(Array.from({ length: count }, (_, index) => {
      const time = window.endTimeExclusive - (count - index) * intervalMs;
      return { s: 'ETH', i: body.req.interval, t: time, T: time + intervalMs - 1, o: '2000.1', h: '2001', l: '1999', c: '2000', v: '0.0001', n: 1 };
    }));
  } });
  assert.equal(result.role, 'execution'); assert.equal(result.informationSource.role, 'information');
  assert.equal(result.informationSource.manifestSha256, sha(readFileSync(input.manifestPath)));
  assert.equal(result.complete, false); assert.equal(result.executionReady, false);
  assert.equal(result.datasets.find(dataset => dataset.interval === '1m').missingRanges[0].rows, 43198);
  assert.equal(result.datasets.find(dataset => dataset.interval === '15m').status, 'complete');
  const rates = result.datasets.find(dataset => dataset.type === 'fundingHistory');
  assert.equal(rates.status, 'complete'); assert.equal(rates.rows, 720); assert.equal(rates.pages.length, 3);
  assert.deepEqual(requests.filter(request => request.type === 'fundingHistory').map(request => request.startTime), [window.startTime, funding[499].time + 1, funding[719].time + 1]);
  assert.equal(result.datasets.find(dataset => dataset.type === 'metaAndAssetCtxs').historical, false);
  assert.equal(result.datasets.find(dataset => dataset.type === 'l2Book').status, 'not-downloaded');
  for (const dataset of result.datasets) for (const artifact of [dataset.raw, dataset.csv, dataset.json, ...(dataset.pages ?? [])].filter(Boolean)) {
    const bytes = readFileSync(join(root, artifact.path));
    assert.equal(bytes.length, artifact.bytes); assert.equal(sha(bytes), artifact.sha256);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'manifest.json'))), result);
});

test('Hyperliquid coverage rejects wrong markets, duplicates and malformed bars and never hides missing funding hours', () => {
  const window = { startTime: 0, endTimeExclusive: 120_000, coin: 'ETH', interval: '1m', intervalMs: 60_000 };
  const candle = { s: 'ETH', i: '1m', t: 0, T: 59_999, o: '2', h: '3', l: '1', c: '2', v: '0', n: 0 };
  assert.equal(candleCoverage([candle], window).status, 'partial');
  assert.throws(() => candleCoverage([candle, candle], window), /Duplicate/);
  assert.throws(() => candleCoverage([{ ...candle, s: 'BTC' }], window), /mismatch/);
  assert.throws(() => candleCoverage([{ ...candle, T: 60_000 }], window), /timestamps/);
  assert.throws(() => candleCoverage([{ ...candle, h: '1' }], window), /OHLCV/);
  const coverage = validateFunding([{ coin: 'ETH', time: 0, fundingRate: '1e-5', premium: '-1e-5' }], { coin: 'ETH', startTime: 0, endTimeExclusive: 7_200_000 });
  assert.equal(coverage.status, 'partial'); assert.deepEqual(coverage.missingHours, [3_600_000]);
});

const OKX_HEADER = 'instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm';
const okxBar = (index, changes = {}) => {
  const values = row(index, changes).split(',');
  return ['ETH-USDT-SWAP', ...values.slice(1, 5), '1', values[5], values[7], values[0], '1'].join(',');
};
const collect = async stream => { const values = []; for await (const value of stream) values.push(value); return values; };
async function okxFixture(t, kind, content, { corruptCrc = false } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'bend-market-e2e-')), raw = join(parent, 'raw'); mkdirSync(raw);
  t.after(() => { assert.equal(dirname(parent), resolve(tmpdir())); assert.ok(basename(parent).startsWith('bend-market-e2e-')); rmSync(parent, { recursive: true, force: true }); });
  let bytes, filename;
  if (kind === 'bookTicker') {
    const pack = tar.pack(); pack.entry({ name: 'book.data' }, content); pack.finalize();
    bytes = gzipSync(Buffer.concat(await collect(pack))); filename = 'book.tar.gz';
  } else if (kind === 'premium') { bytes = Buffer.from(JSON.stringify(content)); filename = 'premium.json'; }
  else {
    bytes = makeZip(content, { name: 'ETH-USDT-SWAP.csv' }); filename = 'market.zip';
    if (corruptCrc) { bytes.writeUInt32LE(0, 14); bytes.writeUInt32LE(0, bytes.readUInt32LE(bytes.length - 6) + 16); }
  }
  writeFileSync(join(raw, filename), bytes);
  const type = { bars: 'candles1m', trades: 'trades', bookTicker: 'l2Book400', premium: 'premiumHistory' }[kind];
  const manifestPath = join(raw, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ schema: 'okx-download-v1', symbol: 'ETH-USDT-SWAP', datasets: [
    { type, status: 'complete', files: [{ path: filename, bytes: bytes.length, sha256: sha(bytes), status: 'verified' }] },
  ] }));
  return { manifestPath, parent, raw, outputDirectory: join(parent, 'processed'), venue: 'okx', kind, startTime: '0', endTime: '120000' };
}
const bookRow = (ts, action = 'snapshot', bids = [['2000', '1']], asks = [['2001', '2']]) => JSON.stringify({ instId: 'ETH-USDT-SWAP', action, ts: String(ts), bids, asks });

test('Binance and OKX archives publish the same canonical bars through the same processing interface', async t => {
  const okx = await okxFixture(t, 'bars', `${OKX_HEADER}\n${okxBar(0)}\n${okxBar(1)}\n`);
  const binance = fixture(t, csv(2));
  const left = await prepareMarketData({ source: await openMarketSource(okx), outputDirectory: okx.outputDirectory });
  const otherOutput = join(okx.parent, 'binance');
  const right = await prepareMarketData({ source: await openMarketSource({ ...binance, venue: 'binance', kind: 'bars', startTime: '0', endTime: '120000' }), outputDirectory: otherOutput });
  const options = { manifestPath: join(okx.outputDirectory, 'manifest.json') };
  assert.deepEqual(await collect(readProcessedData(options)), await collect(readProcessedData({ manifestPath: join(otherOutput, 'manifest.json') })));
  assert.equal(left.rows, 2); assert.equal(right.rows, 2); assert.equal(left.quality.missingBuckets, 0);
  assert.deepEqual(await prepareMarketData({ source: await openMarketSource(okx), outputDirectory: okx.outputDirectory }), left);
  const info = await loadProcessedInformationSource(options);
  assert.equal([...info.observations()].length, 2); assert.equal(info.setTarget, undefined); assert.equal(info.report, undefined);
  await assert.rejects(loadProcessedInformationSource({ ...options, maxRows: 1 }), code('DATA_SIZE'));
  const prepared = await loadProcessedInformationSource({ ...options, directory: join(okx.parent, 'information') });
  const audit = prepared.manifest.audit;
  try {
    assert.deepEqual([...prepared.observations()], [...info.observations()]);
    assert.equal(prepared.manifest.datasetHash, info.manifest.datasetHash);
    assert.equal(prepared.manifest.observationsHash, info.manifest.observationsHash);
    const config = { instrument: info.instrument, initialCash: '10000000', feePerLot: '0', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '60000',
      manifest: { datasetVersion: 'fixture', strategyArtifact: 'buy-one', evaluationProtocol: 'equivalence', seed: '0' } };
    const ticks = ['0', '60000', '120000'].map((time, index) => ({ id: `quote-${index}`, type: 'tick', time, sourceTime: time, sequence: String(index + 1),
      symbol: info.instrument.symbol, currency: info.instrument.currency, bid: '2000000', ask: '2000010', bidLots: '10', askLots: '10' }));
    const replay = source => runStrategy(source, new QuoteExecutionVenue({ id: 'fixture-execution', config, ticks, maxPositionLots: '1', traceMode: 'compact' }),
      ({ observation }) => { assert.ok(Object.isFrozen(observation)); return '1'; }).report();
    const memoryReport = replay(info), diskReport = replay(prepared);
    assert.equal(diskReport.fills.length, 1);
    assert.deepEqual(diskReport.ledger, memoryReport.ledger);
    assert.deepEqual(diskReport.fills, memoryReport.fills);
    assert.equal(diskReport.traceHash, memoryReport.traceHash);
    assert.deepEqual(diskReport.signals, memoryReport.signals);
  } finally { prepared.close(); }
  assert.throws(() => [...prepared.observations()], code('INFORMATION_CLOSED'));
  const reopened = openPreparedInformationSource(audit.manifestPath, { id: 'reused-information' });
  try { assert.equal(reopened.manifest.id, 'reused-information'); assert.deepEqual([...reopened.observations()], [...info.observations()]); }
  finally { reopened.close(); }
  const database = join(dirname(audit.manifestPath), audit.file), changed = readFileSync(database); changed[changed.length - 1] ^= 1; writeFileSync(database, changed);
  assert.throws(() => openPreparedInformationSource(audit.manifestPath), code('AUDIT_CORRUPT'));
  await assert.rejects(prepareMarketData({ source: await openMarketSource(okx), outputDirectory: join(okx.raw, 'processed') }), code('DATA_OUTPUT'));
  await assert.rejects(prepareMarketData({ source: await openMarketSource({ ...okx, publicationDelayMs: '1' }), outputDirectory: okx.outputDirectory }), code('DATA_OUTPUT_EXISTS'));
  const shard = join(okx.outputDirectory, left.files[0].path), bytes = readFileSync(shard); bytes[20] ^= 1; writeFileSync(shard, bytes);
  await assert.rejects(collect(readProcessedData(options)), code('ARCHIVE_INTEGRITY'));
});

test('prepared information never publishes an invalid or interrupted observation stream', async t => {
  const input = await okxFixture(t, 'bars', `${OKX_HEADER}\n${okxBar(0)}\n`);
  const instrument = { symbol: 'TEST', currency: 'USD', lotSize: '1' };
  const observation = time => ({ time, availableAt: time, data: { price: '100' } });
  for (const [name, observations, expected] of [
    ['regression', [observation('1'), observation('0')], code('INFORMATION_TIME')],
    ['interrupted', (async function* () { yield observation('0'); throw new Error('Archive verification failed at EOF'); })(), /Archive verification failed at EOF/],
  ]) {
    const directory = join(input.parent, name);
    await assert.rejects(prepareInformationSource({ id: name, instrument, observations, directory }), expected);
    assert.equal(existsSync(join(directory, 'manifest.json')), false);
  }
});

test('cleanup drops only identical identities, records gaps, and never publishes conflicting or corrupt input', async t => {
  const duplicate = await okxFixture(t, 'bars', `${OKX_HEADER}\n${okxBar(0)}\n${okxBar(0)}\n${okxBar(1)}\n`);
  const result = await prepareMarketData({ source: await openMarketSource(duplicate), outputDirectory: duplicate.outputDirectory });
  assert.equal(result.rows, 2); assert.equal(result.quality.identicalDuplicatesDropped, 1);
  const missing = await okxFixture(t, 'bars', `${OKX_HEADER}\n${okxBar(0)}\n${okxBar(2)}\n`); missing.endTime = '180000';
  const gaps = await prepareMarketData({ source: await openMarketSource(missing), outputDirectory: missing.outputDirectory });
  assert.equal(gaps.quality.missingBuckets, 1); assert.deepEqual(gaps.quality.gapRanges, [{ startTime: '60000', endTime: '120000' }]);
  const path = join(missing.outputDirectory, 'manifest.json');
  await assert.rejects(collect(readProcessedData({ manifestPath: path })), code('DATA_GAPS'));
  assert.equal((await collect(readProcessedData({ manifestPath: path, allowGaps: true }))).length, 2);
  for (const [text, options, expected] of [
    [`${OKX_HEADER}\n${okxBar(0)}\n${okxBar(0, { close: '2000.01' })}\n`, {}, 'DATA_DUPLICATE'],
    [`${OKX_HEADER}\n${okxBar(1)}\n${okxBar(0)}\n`, {}, 'DATA_ORDER'],
    [`${OKX_HEADER}\n${okxBar(0)}\n`, { corruptCrc: true }, 'ZIP_CRC'],
  ]) {
    const input = await okxFixture(t, 'bars', text, options);
    await assert.rejects(prepareMarketData({ source: await openMarketSource(input), outputDirectory: input.outputDirectory }), code(expected));
    assert.equal(JSON.parse(readFileSync(join(input.outputDirectory, 'manifest.json'))).status, 'failed');
    await assert.rejects(collect(readProcessedData({ manifestPath: join(input.outputDirectory, 'manifest.json') })), code('DATA_MANIFEST'));
  }
});

test('exact OKX L2 replay resets snapshots, deletes levels, preserves every event and enforces causal as-of visibility', async t => {
  const input = await okxFixture(t, 'bookTicker', [bookRow(0), bookRow(10, 'update', [['2000', '0'], ['1999', '0.11']], []), bookRow(20, 'snapshot', [['1998', '0.01']], [['1999', '0.02']])].join('\n') + '\n');
  Object.assign(input, { endTime: '30', contractSizeETH: '0.1', publicationDelayMs: '5' });
  const result = await prepareMarketData({ source: await openMarketSource(input), outputDirectory: input.outputDirectory });
  assert.equal(result.rows, 3);
  const records = await collect(readProcessedData({ manifestPath: join(input.outputDirectory, 'manifest.json') }));
  assert.deepEqual(records.map(r => [r.data.bid, r.data.bidSizeLots, r.availableAt]), [['2000000', '100', '5'], ['1999000', '11', '15'], ['1998000', '1', '25']]);
  const aligned = await collect(asOfMarketData(records, ['0', '5', '14', '15', '25', '100'], { maxAgeMs: '20' }));
  assert.deepEqual(aligned.map(r => r.observation?.time ?? r.reason), ['unavailable', '0', '0', '10', '20', 'stale']);
  await assert.rejects(collect(asOfMarketData(records, ['20', '10'], { maxAgeMs: '100' })), code('DATA_ORDER'));
  assert.equal(records[0].data.bidLiquidity, undefined); // Displayed size never becomes a fill budget here.
});

test('L2 processing fails closed on missing snapshots, crossed quotes and inexact contract conversion', async t => {
  for (const [line, expected] of [
    [bookRow(0, 'update'), 'BOOK_SNAPSHOT'],
    [bookRow(0, 'snapshot', [['2002', '1']]), 'BOOK_QUOTE'],
    [bookRow(0, 'snapshot', [['2000', '0.001']]), 'DATA_PRECISION'],
  ]) {
    const input = await okxFixture(t, 'bookTicker', line + '\n'); input.contractSizeETH = '0.1';
    await assert.rejects(prepareMarketData({ source: await openMarketSource(input), outputDirectory: input.outputDirectory }), code(expected));
  }
});

test('trade identities and signed premium observations retain exact values without synthetic fills or gap filling', async t => {
  const trades = await okxFixture(t, 'trades', 'instrument_name,trade_id,side,price,size,created_time,source\nETH-USDT-SWAP,1,buy,2000.01,0.02,0,0\nETH-USDT-SWAP,1,buy,2000.01,0.02,0,0\n');
  trades.contractSizeETH = '0.1';
  const result = await prepareMarketData({ source: await openMarketSource(trades), outputDirectory: trades.outputDirectory });
  assert.equal(result.rows, 1); assert.equal(result.quality.identicalDuplicatesDropped, 1);
  const [trade] = await collect(readProcessedData({ manifestPath: join(trades.outputDirectory, 'manifest.json') }));
  assert.equal(trade.data.price, '2000010'); assert.equal(trade.data.sizeLots, '2');
  const premium = await okxFixture(t, 'premium', [{ instId: 'ETH-USDT-SWAP', ts: '18000', premium: '-0.000000000000123456' }]);
  const processed = await prepareMarketData({ source: await openMarketSource(premium), outputDirectory: premium.outputDirectory });
  assert.equal(processed.quality.missingBuckets, 1);
  const [rate] = await collect(readProcessedData({ manifestPath: join(premium.outputDirectory, 'manifest.json'), allowGaps: true }));
  assert.deepEqual(rate.data.rate, { numerator: '-1929', denominator: '15625000000000000' });
});


test('resumed OKX downloads never replace a saved checksum with changed sample bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'okx-resume-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'data/okx/swap/ETH-USDT-SWAP/2020-01');
  mkdirSync(join(directory, 'l2Book400'), { recursive: true });
  const original = Buffer.from('original sample'), changed = Buffer.from('modified sample');
  const file = { filename: 'ETH-USDT-SWAP-fixture.tar.gz', path: 'l2Book400/fixture.tar.gz',
    status: 'downloaded', sha256: sha(original), bytes: original.length, reusedSample: true };
  writeFileSync(join(directory, file.path), changed);
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ datasets: [{ type: 'l2Book400', files: [file] }] }));
  const script = new URL('../../scripts/download-okx.mjs', import.meta.url).href;
  const stub = `
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = callback => timeout(callback, 0);
    globalThis.fetch = async url => {
      if (new URL(url).hostname !== 'www.okx.com') throw new Error('Unexpected archive download');
      return new Response(JSON.stringify({ code: '0', data: String(url).includes('download-link') ? { details: [] } : [] }));
    };
    process.argv = [process.execPath, 'download-okx.mjs', '2020-01'];
    await import(${JSON.stringify(script)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', stub], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 2, result.stderr);
  const saved = JSON.parse(readFileSync(manifestPath)).datasets.find(dataset => dataset.type === 'l2Book400').files[0];
  assert.equal(saved.status, 'failed'); assert.match(saved.error, /Archive hash mismatch/);
  assert.equal(saved.sha256, file.sha256); assert.deepEqual(readFileSync(join(directory, file.path)), changed);
});

test('cached OKX archive verification rechecks current bytes before accepting its report', t => {
  const python = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (python.status !== 0) return t.skip('Python is required for the offline verifier');
  const root = mkdtempSync(join(tmpdir(), 'okx-verifier-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'data/okx/swap/ETH-USDT-SWAP/2020-01');
  mkdirSync(join(directory, 'validation'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  const script = join(root, 'scripts/verify-okx-download.py');
  writeFileSync(script, readFileSync(new URL('../../scripts/verify-okx-download.py', import.meta.url)));
  const original = Buffer.from('original archive'), changed = Buffer.from('modified archive');
  const file = { path: 'fixture.tar.gz', status: 'verified', sha256: sha(original), bytes: original.length };
  writeFileSync(join(directory, file.path), original);
  writeFileSync(join(directory, 'validation/fixture.tar.gz.json'), JSON.stringify({ ...file,
    records: 1, inWindowRecords: 1, firstTime: 0, lastTime: 0, minuteBuckets: [0], candleTimes: [] }));
  const manifestPath = join(directory, 'manifest.json');
  const pending = { complete: false, downloadFinishedAt: '2020-02-01', window: { startTime: 0, endTimeExclusive: 60000 },
    datasets: [{ type: 'l2Book400', expectedFiles: 1, files: [file] }] };
  const run = () => spawnSync('python', [script, '2020-01'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  writeFileSync(manifestPath, JSON.stringify(pending));
  const valid = run(); assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(readFileSync(manifestPath)).complete, true);
  writeFileSync(manifestPath, JSON.stringify(pending));
  writeFileSync(join(directory, file.path), changed);
  const invalid = run(); assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Hash\/size mismatch/);
  assert.equal(JSON.parse(readFileSync(manifestPath)).complete, false);
});
