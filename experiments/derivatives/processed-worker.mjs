import { join } from 'node:path';
import { loadProcessedDerivativeData } from '../../src/executable-data.mjs';
import { loadProcessedInformationSource } from '../../src/market-data.mjs';
import { DerivativeExecutionVenue, runStrategy, targetPosition } from '../../src/index.mjs';
import { requireThat } from '../../src/core.mjs';

/** Pin processed manifests and shards in registry dependencies before enqueue. */
export default async function(configuration, context) {
  const { parameters: { targetLots }, ...options } = configuration;
  const loaded = await loadProcessedDerivativeData(options);
  const source = await loadProcessedInformationSource({ manifestPath: options.quoteManifestPath,
    startTime: options.startTime, endTime: options.endTime });
  const venue = new DerivativeExecutionVenue({ id: loaded.identity, config: options.config, data: loaded.data,
    auditDirectory: join(context.outputDirectory, 'audit') });
  const report = runStrategy(source, venue, targetPosition(targetLots), { lookback: 1 }).report();
  const reportPath = context.writeArtifact('report.json', report);
  context.writeArtifact('admission.json', { provenance: loaded.provenance, identity: loaded.identity,
    eventCount: loaded.data.events.length, fundingEvents: loaded.data.events.filter(event => event.type === 'funding') });
  requireThat(report.status === 'valid-under-declared-model', 'INVALID_REPORT', 'Processed derivative replay has invalid data quality');
  return { status: report.status, eventCount: loaded.data.events.length, fills: report.audit.streams.fills.count,
    funding: report.performance.funding, report: reportPath, assumptions: loaded.provenance.assumptions };
}
