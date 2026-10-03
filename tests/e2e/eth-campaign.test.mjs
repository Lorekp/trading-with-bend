import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { enqueueExperiment, runQueue, readExperimentResult, verifyExperimentArtifacts } from '../../src/experiments.mjs';
import { readReplayAudit } from '../../src/recording.mjs';
import { json } from '../../src/core.mjs';

const manifestPath = resolve('data/binance/um/ETHUSDT/2026-09/manifest.json');

test('downloaded ETH ZIP -> two parallel workers -> real rules/ML fills -> reconciled immutable artifacts', { skip: !existsSync(manifestPath), timeout: 120000 }, async () => {
  const rootParent = resolve('output'); mkdirSync(rootParent, { recursive: true });
  const root = mkdtempSync(join(rootParent, 'e2e-eth-'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const archive = manifest.datasets.find(data => data.type === 'klines').files[0].path;
  const workerModule = new URL('../../experiments/eth/worker.mjs', import.meta.url);
  try {
    const studies = [
      { type: 'ma-cross', quantity: '100', fast: 2, slow: 8 },
      { type: 'walkforward-ridge', quantity: '100', featureWindow: 4, minTrain: 8, trainingWindow: 24, retrainEvery: 12, entryThreshold: 0, exitThreshold: 0 }
    ];
    for (const strategy of studies) enqueueExperiment(root, { key: strategy.type, workerModule, dependencies: [manifestPath, archive, `${archive}.CHECKSUM`],
      configuration: { manifestPath, intervalMinutes: 5, startTime: '1788220800000', endTime: '1788307200000', strategy } });
    const jobs = await runQueue(root, { concurrency: 2, timeoutMs: 90000 });
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every(job => job.status === 'completed'), JSON.stringify(jobs.map(job => ({ key: job.key, status: job.status, error: job.attempts.at(-1)?.error }))));
    const results = jobs.map(job => readExperimentResult(root, job.key));
    assert.equal(new Set(results.map(result => result.dataHash)).size, 1);
    const audit = spawnSync(process.execPath, ['scripts/audit-eth-campaign.mjs', root], { encoding: 'utf8', timeout: 30000 });
    assert.ifError(audit.error); assert.equal(audit.status, 0, audit.stderr);
    assert.equal(JSON.parse(audit.stdout).trials.length, 2);
    for (const job of jobs) {
      verifyExperimentArtifacts(root, job.key);
      const directory = job.attempts.at(-1).outputDirectory, path = join(directory, 'report.json');
      const report = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(report.fills,undefined,'Campaign artifacts use summary reports');
      for (const name of ['orders','fills','valuations']) report[name]=JSON.parse(json([...readReplayAudit(report,name)]));
      report.barReplay.executionInputs=JSON.parse(json([...readReplayAudit(report.barReplay.executionAudit,'executionInputs')]));
      assert.equal(report.barReplay.count, 288);
      assert.equal(report.softwareChecks.bendCompiler, 'passed');
      assert.equal(report.softwareChecks.bendKernel, JSON.parse(readFileSync('build/verification.json', 'utf8')).kernel);
      assert.ok(report.fills.length > 0, `${job.key} must exercise actual execution`);
      assert.match(report.barReplay.assumptions.account, /no perpetual contract, funding/);
      let cash = 10000000000n, quantity = 0n, fees = 0n;
      const used = new Map(), evidence = new Map(report.barReplay.executionInputs.map(item => [item.eventId, item]));
      for (const fill of report.fills) {
        const lots = BigInt(fill.quantity), price = BigInt(fill.price), fee = BigInt(fill.fee), buy = fill.side === 'buy';
        cash += (buy ? -1n : 1n) * lots * price - fee; quantity += (buy ? 1n : -1n) * lots; fees += fee;
        assert.ok(cash >= 0n && quantity >= 0n);
        assert.ok(BigInt(fill.executionTime) > BigInt(fill.decisionTime));
        const input = evidence.get(fill.marketEventId);
        assert.ok(input && BigInt(input.priorAvailableAt) < BigInt(fill.executionTime));
        assert.equal(fill.price, buy ? input.ask : input.bid);
        const bucket = `${input.eventId}/${fill.side}`;
        used.set(bucket, (used.get(bucket) ?? 0n) + lots);
        assert.ok(used.get(bucket) <= BigInt(input.budgetPerSide));
      }
      assert.equal(report.ledger.cash, String(cash)); assert.equal(report.ledger.quantity, String(quantity));
      assert.equal(report.performance.fees, String(fees));
      assert.equal(report.performance.terminalEquity, String(cash + quantity * BigInt(report.valuations.at(-1).mark)));
      if (job.key === 'walkforward-ridge') {
        const fits = report.barReplay.strategyDiagnostics.fits;
        assert.ok(fits.length > 2);
        for (const fit of fits) {
          assert.ok(BigInt(fit.lastLabelAvailableAt) < BigInt(fit.cutoff));
          assert.ok(BigInt(fit.deployedAt) > BigInt(fit.cutoff));
          const model = JSON.parse(readFileSync(join(directory, 'models', `${fit.modelHash}.json`), 'utf8'));
          assert.equal(model.hash, fit.modelHash);
          assert.equal(model.trainingDataHash, fit.trainingDataHash);
        }
      }
      writeFileSync(path, JSON.stringify({ ...report, ledger: { cash: '1', quantity: '1' } }));
      assert.throws(() => readExperimentResult(root, job.key), { code: 'ARTIFACT_CHANGED' });
    }
  } finally {
    assert.equal(dirname(root), rootParent); rmSync(root, { recursive: true, force: true });
  }
});
