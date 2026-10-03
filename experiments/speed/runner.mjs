import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prepareQuoteData } from '../../src/quote-data.mjs';
import { syntheticQuotes } from '../../src/data.mjs';
import { enqueueExperiment, runQueue, readExperimentResult, listExperiments, verifyExperiment } from '../../src/experiments.mjs';
import { verifiedRuntimeProvenance } from '../../src/provenance.mjs';
import { openReplayAudit } from '../../src/recording.mjs';
import { CanonicalArrayHash, canonical, hash, requireThat } from '../../src/core.mjs';

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let response;
try {
  if (request.action === 'identity') {
    response = { ...verifiedRuntimeProvenance(), node: process.version, v8: process.versions.v8, nodeOptions: process.env.NODE_OPTIONS ?? '' };
  } else if (request.action === 'prepare') {
    const quotes = syntheticQuotes({ ...request.quoteParameters, instrument: request.instrument, count: request.count, seed: String(request.seed) });
    const variablePrice = quotes.some(row => row.bid !== quotes[0].bid);
    const variableLiquidity = quotes.some(row => row.bidLots !== quotes[0].bidLots || row.askLots !== quotes[0].askLots);
    requireThat(request.caseId !== 'quotes-variable-dense' || variablePrice && variableLiquidity,
      'BENCHMARK_FIXTURE', 'Variable fixture must vary prices and liquidity');
    const data = await prepareQuoteData(quotes, { instrument: request.instrument, directory: request.directory });
    try { response = { manifestPath: data.manifest.audit.manifestPath, file: join(request.directory, data.manifest.audit.file),
      inputHash: data.manifest.datasetHash, count: quotes.length, variablePrice, variableLiquidity }; }
    finally { data.close(); }
  } else if (request.action === 'run') {
    const { registry, key, configuration, protocolPath, timeoutMs } = request;
    const manifest = JSON.parse(readFileSync(configuration.manifestPath, 'utf8'));
    const workerModule = new URL('./worker.mjs', import.meta.url);
    enqueueExperiment(registry, { key, workerModule, configuration, seed: configuration.seed,
      dependencies: [protocolPath, process.argv[2], configuration.manifestPath, join(dirname(configuration.manifestPath), manifest.file),
        ...['runner.mjs', 'worker.mjs', 'protocol.mjs', 'statistics.mjs', 'benchmark.mjs', 'quotes.json'].map(name => new URL(name, import.meta.url))] });
    const jobs = await runQueue(registry, { concurrency: 1, timeoutMs });
    requireThat(jobs.length === 1 && jobs[0].key === key, 'BENCHMARK_REGISTRY', 'Expected one isolated registered job');
    const job = jobs[0], attempt = job.attempts.at(-1);
    response = { status: job.status, key, registry, sourceHash: hash(job.toolkit.sources), attempt };
    if (job.status !== 'completed') process.exitCode = 1;
  } else if (request.action === 'inspect') {
    const jobs = listExperiments(request.registry);
    requireThat(jobs.length === 1 && jobs[0].key === request.key, 'BENCHMARK_REGISTRY', 'Expected one isolated job to inspect');
    verifyExperiment(jobs[0]);
    const result = readExperimentResult(request.registry, request.key);
    const report = JSON.parse(readFileSync(join(request.artifacts, 'report.json'), 'utf8'));
    requireThat(report.status === 'valid-under-declared-model' && result.observationCount === request.count &&
      report.signals.count === request.count && report.signals.targetsHash === result.targetsHash &&
      canonical(result.ledger) === canonical(report.ledger) && result.traceHash === report.traceHash &&
      result.targets === Math.ceil((request.count - 1) / request.orderEvery), 'BENCHMARK_EVIDENCE', 'Replay summary or required path differs');
    const audit = openReplayAudit(report.audit), streams = {};
    let buys = 0, sells = 0, cancellations = 0;
    try {
      requireThat(hash(audit.manifest.metadata.config) === report.manifest.configHash, 'BENCHMARK_EVIDENCE', 'Audit configuration differs from report');
      for (const name of Object.keys(audit.manifest.streams).sort()) {
        const digest = new CanonicalArrayHash();
        for (const value of audit.records(name)) {
          digest.push(value);
          if (name === 'fills') { if (value.side === 'buy') buys++; if (value.side === 'sell') sells++; }
          if (name === 'events' && value.type === 'cancel') cancellations++;
        }
        streams[name] = { count: digest.count, hash: digest.digest(), kind: audit.manifest.streams[name].kind };
      }
    } finally { audit.close(); }
    requireThat(buys > 0 && sells > 0 && streams.events.hash === report.manifest.datasetHash && streams.trace.hash === report.traceHash,
      'BENCHMARK_EVIDENCE', 'Expected both roundtrip directions and complete matching event/trace identities');
    // Only declared implementation/build evidence and physical storage fields vary.
    const { sourceHashes, toolchain, proofKernelHash, runtime, ...semanticManifest } = report.manifest;
    const { bendCompiler, bendKernel, ...semanticChecks } = report.softwareChecks;
    const evidence = { ...report, manifest: semanticManifest, softwareChecks: semanticChecks,
      audit: { streams, config: audit.manifest.metadata.config } };
    response = { result, evidenceHash: hash(evidence), evidence, buys, sells, cancellations };
  } else {
    throw new Error(`Unknown runner action: ${request.action}`);
  }
} catch (error) {
  response = { status: 'failed', error: { code: error.code ?? 'BENCHMARK_ERROR', message: error.message } };
  process.exitCode = 1;
}
writeFileSync(request.responsePath, JSON.stringify(response, null, 2), { flag: 'wx', flush: true });
