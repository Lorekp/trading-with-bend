// Public API acquisition only. Prices/sizes stay in native units; no Binance
// observation can supply execution data. Archive gaps remain explicit.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const endpoint = 'https://api.hyperliquid.xyz/info';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const decimal = value => typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value));
const assert = (ok, message) => { if (!ok) throw new Error(message); };

export function monthWindow(month) {
  assert(/^20\d{2}-(0[1-9]|1[0-2])$/.test(month), 'Use YYYY-MM');
  const [year, number] = month.split('-').map(Number);
  return { startTime: Date.UTC(year, number - 1, 1), endTimeExclusive: Date.UTC(year, number, 1) };
}

export function candleCoverage(rows, { coin, interval, intervalMs, startTime, endTimeExclusive }) {
  assert(Array.isArray(rows), 'Candle response must be an array');
  let previous = null;
  for (const row of rows) {
    assert(row.s === coin && row.i === interval, 'Candle instrument/interval mismatch');
    assert(Number.isSafeInteger(row.t) && row.t % intervalMs === 0 && row.T === row.t + intervalMs - 1, 'Invalid candle timestamps');
    assert(row.t >= startTime && row.T < endTimeExclusive, 'Candle outside requested window');
    assert(previous === null || row.t > previous, 'Duplicate or unordered candle');
    assert(['o', 'h', 'l', 'c', 'v'].every(key => decimal(row[key])), 'Invalid candle decimal');
    const [o, h, l, c, v] = ['o', 'h', 'l', 'c', 'v'].map(key => Number(row[key]));
    assert(l > 0 && l <= o && l <= c && h >= o && h >= c && v >= 0, 'Invalid OHLCV');
    assert(Number.isSafeInteger(row.n) && row.n >= 0, 'Invalid trade count');
    previous = row.t;
  }
  const expected = (endTimeExclusive - startTime) / intervalMs, missing = [];
  let next = startTime;
  for (const row of rows) {
    if (row.t > next) missing.push({ startTime: next, endTimeExclusive: row.t, rows: (row.t - next) / intervalMs });
    next = row.t + intervalMs;
  }
  if (next < endTimeExclusive) missing.push({ startTime: next, endTimeExclusive, rows: (endTimeExclusive - next) / intervalMs });
  return { status: rows.length === expected ? 'complete' : rows.length ? 'partial' : 'unavailable', rows: rows.length, expectedRows: expected,
    firstTime: rows[0]?.t ?? null, lastTime: rows.at(-1)?.t ?? null, missingRanges: missing };
}

export function validateFunding(rows, { coin, startTime, endTimeExclusive }) {
  assert(Array.isArray(rows), 'Funding response must be an array');
  let previous = null;
  for (const row of rows) {
    assert(row.coin === coin && Number.isSafeInteger(row.time) && row.time >= startTime && row.time < endTimeExclusive, 'Funding instrument/time mismatch');
    assert(previous === null || row.time > previous, 'Duplicate or unordered funding settlement');
    assert(decimal(row.fundingRate) && decimal(row.premium), 'Invalid funding decimal');
    previous = row.time;
  }
  const hours = new Set(rows.map(row => Math.floor(row.time / 3_600_000)));
  const missing = [];
  for (let time = startTime; time < endTimeExclusive; time += 3_600_000) if (!hours.has(Math.floor(time / 3_600_000))) missing.push(time);
  return { status: missing.length === 0 && rows.length === hours.size ? 'complete' : rows.length ? 'partial' : 'unavailable', rows: rows.length,
    expectedHourlySettlements: (endTimeExclusive - startTime) / 3_600_000, firstTime: rows[0]?.time ?? null, lastTime: rows.at(-1)?.time ?? null,
    missingHours: missing, duplicateHours: rows.length - hours.size };
}

export async function downloadHyperliquid({ binanceManifest, root, request = async body => {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.text();
} }) {
  const inputBytes = readFileSync(binanceManifest), binance = JSON.parse(inputBytes);
  assert(binance.symbol === 'ETHUSDT' && binance.market === 'USD-M perpetual', 'This downloader matches the existing Binance ETHUSDT perpetual dataset');
  const window = monthWindow(binance.month), coin = 'ETH';
  assert(window.endTimeExclusive <= Date.now(), 'Only completed historical months are supported');
  root = resolve(root ?? join('data/hyperliquid/perp/ETH', binance.month));
  const snapshot = join(root, 'snapshots', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
  mkdirSync(snapshot, { recursive: true });
  const manifest = { schema: 'hyperliquid-download-v1', coin, market: 'USDC-collateralized perpetual', month: binance.month,
    role: 'execution', endpoint, window, startedAt: new Date().toISOString(),
    informationSource: { venue: 'binance', symbol: binance.symbol, role: 'information', manifestPath: resolve(binanceManifest), manifestSha256: sha256(inputBytes) },
    units: { price: 'native Hyperliquid USD price per ETH', quantity: 'ETH', collateral: 'USDC', time: 'Unix milliseconds', fundingRate: 'fraction per settlement' },
    datasets: [], executionReady: false, complete: false,
    limitations: [
      'REST candleSnapshot retains only the most recent 5000 candles per interval; requesting older windows cannot bypass retention.',
      'Candles are not executable bid/ask quotes. Coarser candles are not substitutes for missing 1m or order-book data.',
      'Binance USDT prices and Hyperliquid USD prices/USDC collateral retain distinct native units; no implicit currency conversion.',
      'Downloaded funding is not booked by the existing cash-only execution adapters.',
      'Current metadata is a retrieval-time reference, not a historical September margin or fee schedule.',
    ],
    documentation: [
      'https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data',
      'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint',
      'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals',
    ] };
  const save = () => writeFileSync(join(snapshot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const artifact = (name, content) => {
    const path = join(snapshot, name);
    writeFileSync(path, content, { flag: 'wx' });
    return { path: relative(root, path).replaceAll('\\', '/'), bytes: Buffer.byteLength(content), sha256: sha256(content) };
  };
  const acquire = async (name, body) => {
    const raw = await request(body), retrievedAt = new Date().toISOString();
    const file = artifact(name, raw);
    return { rows: JSON.parse(raw), evidence: { ...file, request: body, retrievedAt, integrity: 'local-sha256-over-HTTPS-response; no vendor checksum provided' } };
  };
  save();
  for (const [interval, intervalMs] of [['1m', 60_000], ['5m', 300_000], ['15m', 900_000]]) {
    const dataset = { type: 'candles', interval, status: 'in-progress' };
    manifest.datasets.push(dataset); save();
    try {
      const body = { type: 'candleSnapshot', req: { coin, interval, startTime: window.startTime, endTime: window.endTimeExclusive - 1 } };
      const { rows, evidence } = await acquire(`candles-${interval}.json`, body);
      dataset.raw = evidence;
      Object.assign(dataset, candleCoverage(rows, { coin, interval, intervalMs, ...window }));
      const header = 'open_time,close_time,available_at,open,high,low,close,volume_eth,trade_count';
      dataset.csv = artifact(`candles-${interval}.csv`, [header, ...rows.map(row => [row.t, row.T, row.T + 1, row.o, row.h, row.l, row.c, row.v, row.n].join(','))].join('\n') + '\n');
    } catch (error) { dataset.status = 'failed'; dataset.error = error.message; }
    save(); console.log(`${dataset.type} ${interval}: ${dataset.status}, ${dataset.rows ?? 0}/${dataset.expectedRows ?? '?'} rows`);
  }
  const funding = { type: 'fundingHistory', status: 'in-progress', pages: [] };
  manifest.datasets.push(funding); save();
  try {
    const rows = []; let cursor = window.startTime;
    while (cursor < window.endTimeExclusive) {
      const { rows: page, evidence } = await acquire(`funding-page-${funding.pages.length + 1}.json`, { type: 'fundingHistory', coin, startTime: cursor, endTime: window.endTimeExclusive - 1 });
      funding.pages.push(evidence); save();
      validateFunding(page, { coin, startTime: cursor, endTimeExclusive: window.endTimeExclusive });
      if (page.length === 0) break;
      rows.push(...page); cursor = page.at(-1).time + 1;
    }
    Object.assign(funding, validateFunding(rows, { coin, ...window }));
    funding.json = artifact('funding.json', JSON.stringify(rows, null, 2));
    funding.csv = artifact('funding.csv', ['time,coin,funding_rate,premium', ...rows.map(row => [row.time, row.coin, row.fundingRate, row.premium].join(','))].join('\n') + '\n');
  } catch (error) { funding.status = 'failed'; funding.error = error.message; }
  save(); console.log(`fundingHistory: ${funding.status}, ${funding.rows ?? 0} settlements`);
  const metadata = { type: 'metaAndAssetCtxs', status: 'in-progress', historical: false };
  manifest.datasets.push(metadata); save();
  try {
    const { rows, evidence } = await acquire('current-meta-and-asset-contexts.json', { type: 'metaAndAssetCtxs' });
    metadata.raw = evidence;
    assert(Array.isArray(rows) && Array.isArray(rows[0]?.universe) && Array.isArray(rows[1]), 'Unexpected metadata response');
    const index = rows[0].universe.findIndex(asset => asset.name === coin);
    assert(index >= 0 && rows[1][index], 'ETH missing from metadata');
    metadata.eth = rows[0].universe[index]; metadata.status = 'snapshot-only';
  } catch (error) { metadata.status = 'failed'; metadata.error = error.message; }
  for (const [type, location] of [
    ['l2Book', 's3://hyperliquid-archive/market_data/YYYYMMDD/H/l2Book/ETH.lz4'],
    ['assetContexts', 's3://hyperliquid-archive/asset_ctxs/YYYYMMDD.csv.lz4'],
    ['trades', 's3://hl-mainnet-node-data/node_fills_by_block/YYYYMMDD/'],
  ]) manifest.datasets.push({ type, status: 'not-downloaded', location, requirement: 'Authenticated requester-pays AWS archive access; publication and coverage must be checked' });
  manifest.finishedAt = new Date().toISOString(); save();
  // Publish only after the full attempt is recorded; earlier immutable attempts remain.
  const temporary = join(root, `manifest-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(manifest, null, 2)); renameSync(temporary, join(root, 'manifest.json'));
  console.log(`Manifest: ${join(root, 'manifest.json')}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binanceManifest = resolve(process.argv[2] ?? 'data/binance/um/ETHUSDT/2026-09/manifest.json');
  const result = await downloadHyperliquid({ binanceManifest, root: process.argv[3] });
  // An incomplete execution dataset must not look like a successful full download.
  if (!result.complete) process.exitCode = 2;
}
