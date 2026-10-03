import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const instrument = { symbol: 'BENCH', currency: 'USDT', lotSize: '0.001', priceTick: '1' };
export function* generatedTicks(count) {
  for (let i = 0; i < count; i++) yield {
    id: `tick-${i}`, type: 'tick', sequence: String(i + 1), time: String(i), sourceTime: String(i),
    symbol: instrument.symbol, currency: instrument.currency, bid: '9999', ask: '10000', bidLots: '100', askLots: '100',
  };
}
export function fileHash(path) {
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
}
export function publish(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', flush: true });
}
export function phase(name) {
  const directory = process.env.MEMORY_BENCHMARK_PHASE_DIRECTORY;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, `${process.pid}.ndjson`), `${JSON.stringify({
    name, pid: process.pid, monotonicNs: String(process.hrtime.bigint()),
    clock: 'process.hrtime.bigint', alignment: 'per-process-only', memory: process.memoryUsage(),
    residentHighWaterBytes: process.resourceUsage().maxRSS * 1024,
  })}\n`);
}
export function expectedRoundtrip(count, index, orderEvery) {
  const offset = index % orderEvery;
  const fills = offset >= count - 1 ? 0 : Math.floor((count - 2 - offset) / orderEvery) + 1;
  const buys = Math.ceil(fills / 2), sells = Math.floor(fills / 2);
  return { fills, submissions: fills, events: count + fills,
    ledger: { $: 'Ledger', cash: String(100000000 - buys * 10001 + sells * 9998), quantity: String(buys - sells) } };
}
