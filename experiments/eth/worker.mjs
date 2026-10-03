import { barInformationSource, BarExecutionVenue } from '../../src/index.mjs';
import { performance } from 'node:perf_hooks';
import { loadBinanceBars } from '../../src/binance-bars.mjs';
import { createBarStrategy } from '../../src/bar-strategies.mjs';
import { runBarStrategy } from '../../src/bar-replay.mjs';
import { hash } from '../../src/core.mjs';
import { join } from 'node:path';

export default async function ethExperiment(configuration, context) {
  const started = performance.now();
  const { manifestPath, intervalMinutes = 5, startTime, endTime, strategy: specification,
    execution = {}, initialCash = '10000000000', feePerLot = '1500' } = configuration;
  const dataset = await loadBinanceBars({ manifestPath, intervalMinutes, ...(startTime === undefined ? {} : { startTime }), ...(endTime === undefined ? {} : { endTime }) });
  const loaded = performance.now();
  const strategy = createBarStrategy(specification);
  const config = { instrument: { symbol: 'ETHUSDT-PRICE-PROXY', currency: 'USDT-micro', lotSize: '0.001', priceTick: '10' },
    initialCash, feePerLot, orderLatencyMs: '1', cancelLatencyMs: '1', maxQuoteAgeMs: String(intervalMinutes * 60000), manifest: {
      datasetVersion: hash(dataset.provenance), strategyArtifact: hash(specification),
      evaluationProtocol: 'development-system-verification/online-trailing-only/v1', seed: String(context.seed)
    } };
  const replay = runBarStrategy(
    barInformationSource({ id: 'binance-information', instrument: config.instrument, bars: dataset.bars }),
    new BarExecutionVenue({ id: 'binance-cash-price-proxy', config, bars: dataset.bars, ...execution, maxPositionLots: specification.quantity, traceMode: 'compact', auditDirectory: join(context.outputDirectory,'audit') }),
    strategy);
  const replayed = performance.now();
  const report = replay.report();
  report.sourceData = dataset.provenance;
  report.dataQuality.sourceStatus = dataset.provenance.bookTickerAvailableInManifest
    ? 'Verified klines accepted; this proxy does not load bookTicker'
    : 'Verified klines accepted; bookTicker unavailable in manifest';
  const measured = performance.now();
  const metrics = { ingestMs: Math.round(loaded - started), replayMs: Math.round(replayed - loaded), reportMs: Math.round(measured - replayed),
    totalMs: Math.round(measured - started), bars: dataset.bars.length, events: report.dataQuality.acceptedUniqueEvents,
    fills: report.audit.streams.fills.count, heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576), rssMiB: Math.round(process.memoryUsage().rss / 1048576) };
  context.writeArtifact('report.json', report);
  context.writeArtifact('data-provenance.json', dataset.provenance);
  context.writeArtifact('strategy-diagnostics.json', report.barReplay.strategyDiagnostics);
  for (const model of strategy.modelArtifacts?.() ?? []) context.writeArtifact(`models/${model.hash}.json`, model);
  context.writeArtifact('timings.json', metrics);
  // Keep the registry's result compact; the immutable artifact inventory binds the
  // full report, including fills, valuation samples, timings and model lineage.
  return { strategy: specification, execution: report.barReplay.assumptions, dataHash: report.barReplay.inputBarsHash,
    startTime: report.barReplay.startTime, endTime: report.barReplay.endTime, status: report.status,
    ledger: report.ledger, performance: report.performance, traceHash: report.traceHash, metrics,
    diagnostics: { models: report.barReplay.strategyDiagnostics?.fits?.length ?? 0, predictions: report.barReplay.strategyDiagnostics?.predictions ?? 0 },
    warning: 'System-verification run on perpetual prices using a cash-only proxy; not perpetual P&L or untouched out-of-sample evidence' };
}
