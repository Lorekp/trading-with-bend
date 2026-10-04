import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openMarketSource } from '../src/market-source.mjs';
import { prepareMarketData, processedManifest } from '../src/market-data.mjs';
import { enqueueExperiment, gridJobs, readExperimentResult, runQueue } from '../src/index.mjs';
import { json } from '../src/core.mjs';

// Explicit bar-price/volume proxy with actual funding and risk marks. Inputs are
// already-downloaded local archives; this example performs no market download.
const [manifestPath = 'data/binance/um/ETHUSDT/2026-09/manifest.json', output = 'output/processed-derivatives',
  start = '2026-09-02T00:01:00Z', end = '2026-09-03T00:00:00Z'] = process.argv.slice(2);
const startTime = String(Date.parse(start)), exclusiveEnd = String(Date.parse(end)), endTime = String(BigInt(exclusiveEnd) - 1n);
const root = resolve(output); mkdirSync(root, { recursive: true });
const instrument = { symbol: 'ETH/USDT', currency: 'USDT-micro', lotSize: '0.001', priceTick: '10' };
const config = { instrument, contract: { kind: 'perpetual', payoff: 'linear', contractValue: '1', settlementScale: '1',
  fundingIntervalMs: '28800000', fundingOffsetMs: '0', fundingTimestampToleranceMs: '10' },
  initialCash: '1000000000', maxPositionLots: '100', initialMarginBps: '1000', maintenanceMarginBps: '500',
  feeBps: '5', liquidationFeeBps: '100', slippageBps: '10', orderLatencyMs: '100', cancelLatencyMs: '100',
  maxQuoteAgeMs: '120000', maxMarkAgeMs: '120000' };
for (const kind of ['bars', 'markPrice', 'funding']) {
  const source = await openMarketSource({ venue: 'binance', kind, manifestPath, startTime, endTime: exclusiveEnd,
    ...(kind === 'funding' ? { funding: { source: 'binance-archive', rateRole: 'realized', publicationTime: 'settlement-assumption' } } : {}) });
  await prepareMarketData({ source, outputDirectory: join(root, kind) });
}
const quoteManifestPath = join(root, 'bars', 'manifest.json');
const options = { config, quoteManifestPath, markManifestPath: join(root, 'markPrice', 'manifest.json'),
  fundingManifestPath: join(root, 'funding', 'manifest.json'), startTime, endTime, markRounding: 'floor',
  liquidity: { model: 'bar-volume', participationBps: '10', halfSpreadTicks: '1' } };
const dependencies = [];
for (const path of [options.quoteManifestPath, options.markManifestPath, options.fundingManifestPath]) {
  const manifest = await processedManifest(path);
  dependencies.push(path, ...manifest.files.map(file => resolve(dirname(path), file.path)));
}
const registry = join(root, 'registry');
const [spec] = gridJobs({ namespace: 'processed-derivatives/v1', workerModule: new URL('../experiments/derivatives/processed-worker.mjs', import.meta.url),
  baseConfiguration: options, space: { targetLots: ['10'] }, dependencies });
enqueueExperiment(registry, spec);
const jobs = await runQueue(registry, { concurrency: 1, timeoutMs: 60000 });
const job = jobs.find(record => record.key === spec.key);
const result = job.status === 'completed' ? readExperimentResult(registry, spec.key) : null;
console.log(json({ registry, key: spec.key, status: job.status, result, error: job.attempts.at(-1)?.error ?? null }));
if (job.status !== 'completed') process.exitCode = 1;
