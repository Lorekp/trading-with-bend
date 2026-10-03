import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { openQuoteData } from '../../src/quote-data.mjs';
import { runStrategy } from '../../src/replay.mjs';
import { quoteInformationSource } from '../../src/information-source.mjs';
import { QuoteExecutionVenue } from '../../src/execution-venue.mjs';
import { requireThat } from '../../src/core.mjs';

export default async function(configuration, context) {
  const { manifestPath, inputHash, count, caseId, seed, orderEvery, lookback } = configuration;
  const { traceMode, orderStorage, reportDetail, execution } = configuration;
  const phases = {}, cpu = {};
  const measure = (name, work) => {
    const beforeCpu = process.cpuUsage(), before = performance.now();
    const result = work();
    phases[name] = performance.now() - before;
    cpu[name] = process.cpuUsage(beforeCpu);
    return result;
  };
  const data = measure('admissionMs', () => openQuoteData(manifestPath));
  let venue;
  try {
    requireThat(data.manifest.datasetHash === inputHash && data.manifest.audit.streams.quotes.count === count,
      'BENCHMARK_INPUT', 'Worker input identity or count differs from protocol');
    let source, strategy, targets = 0;
    measure('setupMs', () => {
      const config = {
        instrument: data.instrument, ...configuration.execution,
        manifest: { datasetVersion: inputHash, strategyArtifact: 'speed-periodic-one-lot-v1', evaluationProtocol: `performance-only/${caseId}`, seed: String(seed) },
      };
      venue = new QuoteExecutionVenue({ id: 'speed-venue', config, ticks: data, maxPositionLots: '1', traceMode, orderStorage,
        auditDirectory: join(context.outputDirectory, 'audit') });
      source = quoteInformationSource({ id: 'speed-source', instrument: data.instrument, ticks: data });
      strategy = ({ index, ledger }) => {
        if (index >= count - 1 || index % orderEvery !== 0) return null;
        targets++;
        return ledger.quantity === 0n ? '1' : '0';
      };
    });
    const replay = measure('replayMs', () => runStrategy(source, venue, strategy, { lookback }));
    const report = measure('reportMs', () => replay.report({ detail: reportDetail }));
    measure('publishMs', () => context.writeArtifact('report.json', report));
    return {
      workload: { caseId, count, seed, inputHash, instrument: data.instrument, execution,
        orderEvery, lookback, traceMode, orderStorage, reportDetail },
      phases, cpu, targets, observationCount: replay.observationCount, targetsHash: replay.targetsHash,
      counts: Object.fromEntries(Object.entries(report.audit.streams).map(([name, row]) => [name, row.count])),
      auditBytes: report.audit.bytes, traceHash: report.traceHash, ledger: report.ledger,
      peakRssMiB: process.resourceUsage().maxRSS / 1024, memorySnapshotBytes: process.memoryUsage(),
      runtime: { node: process.version, v8: process.versions.v8, execArgv: process.execArgv,
        nodeOptions: process.env.NODE_OPTIONS ?? '', heapLimitBytes: getHeapStatistics().heap_size_limit, pid: process.pid },
    };
  } catch (error) { venue?.abort(); throw error; }
  finally { data.close(); }
}
