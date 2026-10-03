import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { runStrategy, quoteInformationSource, QuoteExecutionVenue } from '../src/index.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
};
const count = Number(option('--ticks', '2000'));
const targetOrders = Number(option('--orders', '50'));
const lookbackValue = option('--lookback', '256');
const lookback = lookbackValue === 'all' ? 'all' : Number(lookbackValue);
const traceMode = option('--trace', 'compact');
const orderStorage = option('--order-storage', 'active');
const auditDirectory = option('--audit-directory', undefined);
const dataDirectory = option('--data-directory', undefined);
if (!Number.isSafeInteger(count) || count < 2 || !Number.isSafeInteger(targetOrders) || targetOrders < 0 || targetOrders >= count) throw new Error('Require ticks >= 2 and 0 <= orders < ticks');
if (lookback !== 'all' && (!Number.isSafeInteger(lookback) || lookback <= 0)) throw new Error('Require --lookback all or a positive safe integer');
if (auditDirectory !== undefined && args.includes('--no-report')) throw new Error('Disk audits require reporting to seal their evidence; omit --no-report');
const config = {
  instrument: { symbol: 'BENCH', currency: 'USDT', lotSize: '0.001', priceTick: '1' },
  initialCash: '100000000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '60000',
  manifest: { datasetVersion: `deterministic-benchmark-${count}`, strategyArtifact: 'periodic-one-lot-roundtrip', evaluationProtocol: 'performance-only', seed: '0' },
};
function* generatedTicks() {
  for (let i = 0; i < count; i++) yield {
    id: `tick-${i}`, type: 'tick', sequence: String(i + 1), time: String(i * 1000), sourceTime: String(i * 1000),
    symbol: 'BENCH', currency: 'USDT', bid: '9999', ask: '10000', bidLots: '100', askLots: '100',
  };
}
let seen = 0, submitted = 0;
const every = Math.max(1, Math.floor((count - 1) / Math.max(1, targetOrders)));
const strategy = ({ ledger }) => {
  seen++;
  if (submitted >= targetOrders || (seen - 1) % every !== 0 || seen === count) return null;
  submitted++;
  return ledger.quantity > 0n ? '0' : '1';
};
global.gc?.();
const profiler = args.includes('--profile') ? new Session() : null;
const profileCall = method => new Promise((resolve, reject) => profiler.post(method, (error, result) => error ? reject(error) : resolve(result)));
if (profiler) { profiler.connect(); await profileCall('Profiler.enable'); await profileCall('Profiler.start'); }
const initial = process.memoryUsage(), start = performance.now();
const prepared = dataDirectory === undefined ? null : await (await import('../src/quote-data.mjs')).prepareQuoteData(
  generatedTicks(), { instrument: config.instrument, directory: dataDirectory });
const ticks = prepared ?? [...generatedTicks()];
const preparedAt = performance.now();
let venue, run, report, replayFinished, replayMemory, reportedAt;
try {
  venue = new QuoteExecutionVenue({ id: 'benchmark-execution', config, ticks, maxPositionLots: '1', traceMode, orderStorage,
    ...(auditDirectory === undefined ? {} : { auditDirectory }) });
  run = venue.backtest;
  const replay = runStrategy(quoteInformationSource({ id: 'benchmark-information', instrument: config.instrument, ticks }), venue, strategy, { lookback });
  replayFinished = performance.now(); replayMemory = process.memoryUsage();
  report = args.includes('--no-report') ? null : replay.report();
  reportedAt = performance.now();
} catch (error) {
  run?.abort();
  throw error;
} finally {
  prepared?.close();
}
const end = performance.now(), final = process.memoryUsage(), peakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
let profile;
if (profiler) {
  const stopped = await profileCall('Profiler.stop'); profiler.disconnect();
  const samples = stopped.profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0);
  profile = stopped.profile.nodes.filter(node => node.hitCount > 0).sort((a, b) => b.hitCount - a.hitCount).slice(0, 12).map(node => ({ function: node.callFrame.functionName || '(anonymous)', file: node.callFrame.url.split('/').at(-1), line: node.callFrame.lineNumber + 1, selfPercent: Math.round(1000 * node.hitCount / samples) / 10 }));
}
console.log(JSON.stringify({
  label: option('--label', 'benchmark'), ticks: count, targetOrders, submitted, lookback, traceMode, orderStorage,
  dataStorage: dataDirectory === undefined ? 'memory' : 'disk', auditStorage: auditDirectory === undefined ? 'memory' : 'disk',
  preparationMs: Math.round(preparedAt - start), replayMs: Math.round(replayFinished - preparedAt),
  reportMs: Math.round(reportedAt - replayFinished), finalizeMs: Math.round(end - reportedAt), totalMs: Math.round(end - start),
  replayHeapMiB: Math.round(replayMemory.heapUsed / 1048576), finalHeapMiB: Math.round(final.heapUsed / 1048576),
  rssMiB: Math.round(final.rss / 1048576), peakRssMiB, initialHeapMiB: Math.round(initial.heapUsed / 1048576),
  fills: run.recordingCounts.fills, traceHash: report?.traceHash ?? null,
  ledger: report?.ledger ?? { cash: String(run.ledger.cash), quantity: String(run.ledger.quantity) },
  ...(profile ? { profile } : {}),
}, null, 2));
