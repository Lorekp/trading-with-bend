import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listExperiments, readExperimentResult } from '../src/experiments.mjs';
import { hash } from '../src/framework.mjs';
import { validateRidgeModel } from '../src/models.mjs';

const root = resolve(process.argv[2] || 'output/eth-september-verified-v03');
const jobs = listExperiments(root), audited = [];
assert.ok(jobs.length > 0, 'No registered experiments');
for (const job of jobs) {
  assert.equal(job.status, 'completed', `${job.key}: retain and investigate failed or incomplete jobs`);
  const result = readExperimentResult(root, job.key); // Also verifies every artifact digest.
  const report = JSON.parse(readFileSync(join(job.attempts.at(-1).outputDirectory, 'report.json'), 'utf8'));
  assert.equal(report.status, 'valid-under-declared-model');
  assert.equal(report.barReplay.inputBarsHash, result.dataHash);
  assert.equal(hash(report.trace), report.traceHash);
  assert.equal(report.traceHash, result.traceHash);
  const evidence = new Map(report.barReplay.executionInputs.map(item => [item.eventId, item]));
  const orders = new Map(report.orders.map(order => [order.id, order]));
  const filledByOrder = new Map(), used = new Map();
  let cash = BigInt(report.performance.initialEquity), quantity = 0n, fees = 0n;
  for (const fill of report.fills) {
    const lots = BigInt(fill.quantity), price = BigInt(fill.price), fee = BigInt(fill.fee), buy = fill.side === 'buy';
    assert.ok(buy || fill.side === 'sell'); assert.ok(lots > 0n);
    const order = orders.get(fill.orderId); assert.ok(order);
    assert.ok(buy ? price <= BigInt(order.limit) : price >= BigInt(order.limit));
    const input = evidence.get(fill.marketEventId); assert.ok(input);
    assert.equal(fill.price, buy ? input.ask : input.bid);
    assert.ok(BigInt(fill.executionTime) > BigInt(fill.decisionTime));
    assert.ok(BigInt(fill.executionTime) >= BigInt(fill.exchangeArrival));
    assert.ok(BigInt(input.priorAvailableAt) < BigInt(fill.executionTime));
    assert.ok(BigInt(input.openTime) < BigInt(fill.executionTime));
    assert.equal(fee, lots * BigInt(job.configuration.feePerLot ?? '1500'));
    const bucket = fill.liquidityBucket;
    used.set(bucket, (used.get(bucket) ?? 0n) + lots);
    assert.ok(used.get(bucket) <= BigInt(input.budgetPerSide));
    filledByOrder.set(fill.orderId, (filledByOrder.get(fill.orderId) ?? 0n) + lots);
    cash += (buy ? -1n : 1n) * lots * price - fee;
    quantity += (buy ? 1n : -1n) * lots; fees += fee;
    assert.ok(cash >= 0n && quantity >= 0n);
  }
  for (const order of report.orders) {
    assert.equal(BigInt(order.accepted), BigInt(order.remaining) + BigInt(order.filled) + BigInt(order.cancelled));
    assert.equal(BigInt(order.filled), filledByOrder.get(order.id) ?? 0n);
  }
  const final = report.valuations.at(-1), equity = cash + quantity * BigInt(final.mark);
  assert.equal(String(cash), report.ledger.cash); assert.equal(String(quantity), report.ledger.quantity);
  assert.equal(String(fees), report.performance.fees); assert.equal(String(equity), report.performance.terminalEquity);
  assert.equal(String(equity - BigInt(report.performance.initialEquity)), report.performance.netPnl);
  assert.deepEqual(result.performance, report.performance);
  const diagnostics = report.barReplay.strategyDiagnostics;
  for (const fit of diagnostics.fits ?? []) {
    const model = JSON.parse(readFileSync(join(job.attempts.at(-1).outputDirectory, 'models', `${fit.modelHash}.json`), 'utf8'));
    validateRidgeModel({ model, schema: diagnostics.schema, fold: fit.fold, decisionTime: model.deployedAt });
    assert.equal(model.hash, fit.modelHash); assert.equal(model.preprocessingHash, fit.preprocessingHash);
    assert.ok(BigInt(fit.lastLabelAvailableAt) < BigInt(fit.cutoff));
    assert.ok(BigInt(fit.cutoff) <= BigInt(fit.trainingStartedAt));
    assert.ok(BigInt(fit.trainingStartedAt) <= BigInt(fit.trainingCompletedAt));
    assert.ok(BigInt(fit.trainingCompletedAt) <= BigInt(fit.deployedAt));
  }
  audited.push({ key: job.key, bars: report.barReplay.count, fills: report.fills.length, models: diagnostics.fits?.length ?? 0,
    netPnlMicroUSDT: report.performance.netPnl, feesMicroUSDT: report.performance.fees, dataHash: result.dataHash, traceHash: report.traceHash, status: 'passed' });
}
assert.equal(new Set(audited.map(trial => trial.dataHash)).size, 1, 'All campaign trials must use identical bars');
const output = { scope: 'Independent arithmetic, timing, liquidity, model chronology and saved artifact audit; execution-model validity is assumed', trials: audited };
const path = join(root, `audit-${randomUUID()}.json`);
writeFileSync(path, JSON.stringify(output, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ path, ...output }, null, 2));
