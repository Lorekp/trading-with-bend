import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { join } from 'node:path';
import { openQuoteData, quoteInformationSource, QuoteExecutionVenue, runStrategy } from '../../src/index.mjs';

export default async function ({ manifestPath, count, index, orderEvery = 288, profile = false }, context) {
  const profiler = profile ? new Session() : null;
  const call = method => new Promise((resolve, reject) => profiler.post(method, (error, result) => error ? reject(error) : resolve(result)));
  if (profiler) { profiler.connect(); await call('Profiler.enable'); await call('Profiler.start'); }
  const started = performance.now(), data = openQuoteData(manifestPath), admitted = performance.now();
  const config = { instrument: data.instrument, initialCash: '100000000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '60000',
    manifest: { datasetVersion: data.manifest.datasetHash, strategyArtifact: 'scaling-roundtrip', evaluationProtocol: 'capacity-only', seed: String(index) } };
  let venue, report, replayed, reported;
  try {
    venue = new QuoteExecutionVenue({ id: 'scaling-venue', config, ticks: data, maxPositionLots: '1', auditDirectory: join(context.outputDirectory, 'audit') });
    const run = runStrategy(quoteInformationSource({ id: 'scaling-source', instrument: data.instrument, ticks: data }), venue,
      ({ index: row, ledger }) => row < count - 1 && row % orderEvery === index % orderEvery ? (ledger.quantity === 0n ? '1' : '0') : null,
      { lookback: 256 });
    replayed = performance.now(); report = run.report(); reported = performance.now();
    context.writeArtifact('report.json', report);
  } catch (error) { venue?.abort(); throw error; }
  finally { data.close(); }
  let cpu;
  if (profiler) {
    const stopped = await call('Profiler.stop'); profiler.disconnect();
    context.writeArtifact('replay.cpuprofile', stopped.profile);
    const total = stopped.profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0);
    cpu = stopped.profile.nodes.filter(node => node.hitCount > 0).sort((a,b) => b.hitCount-a.hitCount).slice(0,15)
      .map(node => ({ function: node.callFrame.functionName, file: node.callFrame.url.split('/').at(-1), selfPercent: 100*node.hitCount/total }));
  }
  return { index, count, admissionMs: admitted-started, replayMs: replayed-admitted, reportMs: reported-replayed,
    elapsedMs: performance.now()-started, peakRssMiB: process.resourceUsage().maxRSS/1024,
    heapMiB: process.memoryUsage().heapUsed/1048576, auditBytes: report.audit.bytes, fills: report.audit.streams.fills.count,
    traceHash: report.traceHash, ledger: report.ledger, ...(cpu ? {cpu} : {}) };
}
