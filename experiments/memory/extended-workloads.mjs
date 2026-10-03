import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Backtest } from '../../src/framework.mjs';
import { openQuoteData } from '../../src/quote-data.mjs';
import { phase, generatedTicks, instrument } from './support.mjs';

const config = { instrument, initialCash: '100000000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '60000',
  manifest: { datasetVersion: 'memory-working-orders-v1', strategyArtifact: 'fifo-partial-cancel-v1', evaluationProtocol: 'capacity-only', seed: '41' } };

export function orderChurn(configuration, context) {
  const { count, workingOrders } = configuration;
  const run = new Backtest(config, { auditDirectory: join(context.outputDirectory, 'audit') });
  let sequence = 0, orders = 0, fills = 0, cancelled = 0;
  const base = (type, time, id) => ({ type, id, time: String(time), sequence: String(++sequence), symbol: instrument.symbol, currency: instrument.currency });
  phase('churn:start');
  try {
    for (let i = 0; i < count; i++) {
      const ids = [];
      for (let j = 0; j < workingOrders; j++) {
        const orderId = String(++orders); ids.push(orderId);
        run.step({ ...base('submit', i * 3, `submit-${orders}`), orderId, side: 'buy', quantity: '2', limit: '100' });
      }
      const tick = { ...base('tick', i * 3 + 1, `quote-${i}`), sourceTime: String(i * 3 + 1), bid: '99', ask: '100', bidLots: '1', askLots: '1' };
      run.step(tick); fills++;
      for (const orderId of ids) {
        run.step({ ...base('cancel', i * 3 + 2, `cancel-${orderId}`), orderId });
        cancelled += orderId === ids[0] ? 1 : 2;
      }
    }
    const report = run.report(); phase('churn:complete');
    if (report.ledger.cash !== String(100000000 - count * 101) || report.ledger.quantity !== String(count) || run.workingOrders.length !== 0 || run.recordingCounts.fills !== fills) throw new Error('BENCHMARK_CORRECTNESS: partial-fill/cancel oracle differs');
    context.writeArtifact('report.json', report);
    return { count, workingOrders, submissions: orders, cancelledLots: cancelled, fills, ledger: report.ledger,
      traceHash: report.traceHash, audit: report.audit, correctness: 'passed' };
  } catch (error) { run.abort(); throw error; }
}

export function checkpointRestore(configuration, context) {
  phase('checkpoint:admission');
  const checkpoint = JSON.parse(readFileSync(configuration.checkpointPath, 'utf8'));
  const run = Backtest.resume(checkpoint, { auditDirectory: join(context.outputDirectory, 'audit') });
  phase('checkpoint:restored');
  try {
    let sequence = BigInt(run.lastSequence);
    for (const tick of generatedTicks(configuration.count)) {
      if (BigInt(tick.time) <= BigInt(configuration.prefix - 1)) continue;
      run.step({ ...tick, sequence: String(++sequence) });
    }
    const report = run.report();
    if (report.ledger.cash !== config.initialCash || report.ledger.quantity !== '0' || report.dataQuality.acceptedUniqueEvents !== configuration.count) throw new Error('BENCHMARK_CORRECTNESS: checkpoint continuation differs');
    context.writeArtifact('report.json', report); phase('checkpoint:complete');
    return { count: configuration.count, prefix: configuration.prefix, ledger: report.ledger, fills: 0,
      traceHash: report.traceHash, audit: report.audit, correctness: 'passed' };
  } catch (error) { run.abort(); throw error; }
}

export function checkpointPrepare(configuration, context) {
  const { prefix } = configuration, data = openQuoteData(configuration.manifestPath);
  const run = new Backtest({ ...config, manifest: { ...config.manifest, datasetVersion: data.manifest.datasetHash } }, { auditDirectory: join(context.outputDirectory, 'audit') });
  phase('checkpoint:prepare');
  try {
    let seen = 0;
    for (const tick of data.rows()) { if (seen++ === prefix) break; run.step(tick); }
    const checkpoint = run.checkpoint();
    context.writeArtifact('checkpoint.json', checkpoint);
    run.abort(); phase('checkpoint:prepared');
    return { count: configuration.count, prefix, checkpointPath: join(context.outputDirectory, 'checkpoint.json'), audit: checkpoint.audit, correctness: 'passed' };
  } finally { data.close(); run.abort(); }
}
