import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { prepareQuoteData, openQuoteData, quoteInformationSource, QuoteExecutionVenue, runStrategy } from '../../src/index.mjs';
import { generatedTicks, instrument, phase, expectedRoundtrip } from './support.mjs';

export default async function work(configuration, context) {
  const { kind, count, index = 0, orderEvery = 288, lookback = 256, traceMode = 'compact',
    orderStorage = 'active', dataStorage = 'disk', auditStorage = 'disk', detail = 'summary' } = configuration;
  phase('worker:start');
  if (['churn', 'checkpoint-prepare', 'checkpoint-restore'].includes(kind)) {
    const workloads = await import('./extended-workloads.mjs');
    return kind === 'churn' ? workloads.orderChurn(configuration, context) : kind === 'checkpoint-prepare'
      ? workloads.checkpointPrepare(configuration, context) : workloads.checkpointRestore(configuration, context);
  }
  if (kind === 'retention') {
    const cycles = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      const prefix = `cycles/${cycle}`, directory = join(context.outputDirectory, prefix);
      mkdirSync(directory, { recursive: true });
      const result = await work({ ...configuration, kind: 'replay' }, { ...context, outputDirectory: directory,
        writeArtifact: (name, value) => context.writeArtifact(`${prefix}/${name}`, value) });
      cycles.push({ cycle, result, postCleanupMemory: process.memoryUsage() });
    }
    context.writeArtifact('retention.json', cycles);
    return { count, cycles, correctness: 'passed', gc: 'natural' };
  }
  if (kind === 'calibration') {
    if (configuration.mode !== 'idle') {
      phase('burst:start');
      if (configuration.mode.startsWith('native')) {
        if (!process.env.MEMORY_BENCHMARK_HELPER) throw new Error('Native calibration helper requires Windows');
        const argumentsForBurst = ['--burst', String(128 * 1048576), configuration.mode === 'native-orphan' ? '700' : '100'];
        if (configuration.mode === 'native-orphan') {
          const child = spawn(process.env.MEMORY_BENCHMARK_HELPER, argumentsForBurst, { windowsHide: true, stdio: 'ignore', detached: true });
          await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
          child.unref();
        } else if (configuration.mode === 'native-overlap') {
          await Promise.all([0, 1].map(() => new Promise((resolveExit, reject) => {
            const child = spawn(process.env.MEMORY_BENCHMARK_HELPER, argumentsForBurst, { windowsHide: true, stdio: 'ignore' });
            child.once('error', reject); child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`Native burst exit ${code}`)));
          })));
        } else {
          for (let i = 0; i < (configuration.mode === 'native-sequential' ? 2 : 1); i++) {
            const child = spawnSync(process.env.MEMORY_BENCHMARK_HELPER, argumentsForBurst, { windowsHide: true, encoding: 'utf8' });
            if (child.error || child.status !== 0 || Number(child.stdout.trim()) !== 128 * 1048576) throw new Error(`Native calibration failed: ${child.error?.message ?? child.stderr ?? child.status}`);
          }
        }
        context.writeArtifact('allocation.json', { bytesPerChild: 128 * 1048576, mode: configuration.mode, storage: 'native-VirtualAlloc' });
      } else {
        const data = Buffer.alloc(128 * 1048576, 1);
        const end = performance.now() + 100;
        while (performance.now() < end) { /* synchronous burst prevents in-process timer sampling */ }
        context.writeArtifact('allocation.json', { bytes: data.length, first: data[0], last: data.at(-1) });
      }
      phase('burst:complete');
    }
    return { mode: configuration.mode, correctness: 'passed', count: 0 };
  }
  if (kind === 'prepare') {
    phase('preparation:start');
    const data = await prepareQuoteData(generatedTicks(count), { instrument, directory: join(context.outputDirectory, 'data') });
    const result = { count, manifestPath: data.manifest.audit.manifestPath, datasetHash: data.manifest.datasetHash };
    data.close(); phase('preparation:complete');
    return result;
  }
  if (kind !== 'replay') throw new Error(`Unknown memory workload ${kind}`);
  const started = performance.now();
  phase('admission:start');
  const data = dataStorage === 'disk' ? openQuoteData(configuration.manifestPath) : null;
  const ticks = data ?? [...generatedTicks(count)];
  const datasetHash = data?.manifest.datasetHash ?? configuration.datasetHash;
  const config = { instrument, initialCash: '100000000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '60000',
    manifest: { datasetVersion: datasetHash, strategyArtifact: 'memory-roundtrip-v1', evaluationProtocol: 'capacity-only', seed: String(index) } };
  let venue, result;
  try {
    phase('admission:complete');
    venue = new QuoteExecutionVenue({ id: 'memory-venue', config, ticks, maxPositionLots: '1', traceMode, orderStorage,
      ...(auditStorage === 'disk' ? { auditDirectory: join(context.outputDirectory, 'audit') } : {}) });
    phase('replay:start');
    let submissions = 0;
    const replay = runStrategy(quoteInformationSource({ id: 'memory-source', instrument, ticks }), venue,
      ({ index: row, ledger }) => {
        if (row >= count - 1 || row % orderEvery !== index % orderEvery) return null;
        submissions++;
        return ledger.quantity === 0n ? '1' : '0';
      }, { lookback });
    phase('replay:complete');
    phase('report:start');
    const report = replay.report({ detail });
    phase('report:complete');
    const expected = expectedRoundtrip(count, index, orderEvery);
    const counts = venue.backtest.recordingCounts;
    if (replay.observationCount !== count || submissions !== expected.submissions || counts.fills !== expected.fills || counts.events !== expected.events ||
      report.ledger.cash !== expected.ledger.cash || report.ledger.quantity !== expected.ledger.quantity || report.status !== 'valid-under-declared-model' ||
      BigInt(report.reservations.cashReserved) !== 0n || BigInt(report.reservations.quantityReserved) !== 0n) throw new Error('BENCHMARK_CORRECTNESS: roundtrip oracle differs');
    phase('artifacts:start');
    context.writeArtifact('report.json', report);
    phase('artifacts:complete');
    result = { index, count, observationCount: replay.observationCount, submissions, fills: counts.fills, events: counts.events,
      elapsedMs: performance.now() - started, auditBytes: report.audit?.bytes ?? 0,
      traceHash: report.traceHash, signalsHash: report.signals.targetsHash, ledger: report.ledger,
      audit: report.audit ?? null, correctness: 'passed' };
  } catch (error) { venue?.abort(); throw error; }
  finally { data?.close(); phase('cleanup:complete'); }
  return result;
}
