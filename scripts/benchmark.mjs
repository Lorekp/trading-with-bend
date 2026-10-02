import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { runStrategy } from '../src/framework.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const count = Number(option('--ticks', '2000'));
const targetOrders = Number(option('--orders', '50'));
const lookbackValue = option('--lookback', 'full');
const lookback = lookbackValue === 'full' ? undefined : Number(lookbackValue);
const traceMode = option('--trace', 'full');
const orderStorage = option('--order-storage', 'all');
if (!Number.isSafeInteger(count) || count < 2 || !Number.isSafeInteger(targetOrders) || targetOrders < 0 || targetOrders >= count) throw new Error('Require ticks >= 2 and 0 <= orders < ticks');
const config = {
  instrument: { symbol: 'BENCH', currency: 'USDT', lotSize: '0.001', priceTick: '1' },
  initialCash: '100000000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '60000',
  manifest: { datasetVersion: `deterministic-benchmark-${count}`, strategyArtifact: 'periodic-one-lot-roundtrip', evaluationProtocol: 'performance-only', seed: '0' },
};
const ticks = Array.from({ length: count }, (_, i) => ({
  id: `tick-${i}`, type: 'tick', sequence: String(i + 1), time: String(i * 1000), sourceTime: String(i * 1000),
  symbol: 'BENCH', currency: 'USDT', bid: '9999', ask: '10000', bidLots: '100', askLots: '100',
}));
let seen = 0, submitted = 0;
const every = Math.max(1, Math.floor((count - 1) / Math.max(1, targetOrders)));
const strategy = ({ history, ledger }) => {
  seen++;
  if (submitted >= targetOrders || (seen - 1) % every !== 0 || seen === count) return [];
  submitted++;
  const side = ledger.quantity > 0n ? 'sell' : 'buy';
  return [{ type: 'submit', side, limit: side === 'buy' ? history.at(-1).ask : history.at(-1).bid, quantity: '1' }];
};
global.gc?.();
const profiler = args.includes('--profile') ? new Session() : null;
const profileCall = method => new Promise((resolve, reject) => profiler.post(method, (error, result) => error ? reject(error) : resolve(result)));
if (profiler) { profiler.connect(); await profileCall('Profiler.enable'); await profileCall('Profiler.start'); }
const initial = process.memoryUsage(), start = performance.now();
const run = runStrategy(config, ticks, strategy, { ...(lookback === undefined ? {} : { lookback }), traceMode, orderStorage });
const replayFinished = performance.now(), replayMemory = process.memoryUsage();
let profile;
if (profiler) {
  const stopped = await profileCall('Profiler.stop'); profiler.disconnect();
  const samples = stopped.profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0);
  profile = stopped.profile.nodes.filter(node => node.hitCount > 0).sort((a, b) => b.hitCount - a.hitCount).slice(0, 12).map(node => ({ function: node.callFrame.functionName || '(anonymous)', file: node.callFrame.url.split('/').at(-1), line: node.callFrame.lineNumber + 1, selfPercent: Math.round(1000 * node.hitCount / samples) / 10 }));
}
const report = args.includes('--no-report') ? null : run.report();
const end = performance.now(), final = process.memoryUsage();
console.log(JSON.stringify({
  label: option('--label', 'benchmark'), ticks: count, targetOrders, submitted, lookback: lookback ?? 'full', traceMode, orderStorage,
  replayMs: Math.round(replayFinished - start), reportMs: Math.round(end - replayFinished), totalMs: Math.round(end - start),
  replayHeapMiB: Math.round(replayMemory.heapUsed / 1048576), finalHeapMiB: Math.round(final.heapUsed / 1048576),
  rssMiB: Math.round(final.rss / 1048576), initialHeapMiB: Math.round(initial.heapUsed / 1048576),
  fills: run.fills.length, traceHash: report?.traceHash ?? null,
  ledger: report?.ledger ?? { cash: String(run.state.ledger.cash), quantity: String(run.state.ledger.quantity) },
  ...(profile ? { profile } : {}),
}, null, 2));
