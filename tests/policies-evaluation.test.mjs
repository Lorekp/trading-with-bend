import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { cappedLots, affordableLots, trainingAllowed, canReadPartition, modelReady } from '../src/policies.mjs';
import { walkForwardSplits, foldRows, withFinalHoldout, regularReturns, comparisonTable } from '../src/evaluation.mjs';
import { Backtest } from '../src/framework.mjs';
import { hash, MAX_NAT } from '../src/core.mjs';
import { evaluateStudy, sampleEquity, selectStudy } from '../src/study.mjs';
import { quoteInformationSource } from '../src/information-source.mjs';
import { QuoteExecutionVenue } from '../src/execution-venue.mjs';
import { targetPosition } from '../src/strategies.mjs';
import researchWorker from '../examples/research-worker.mjs';

const samples = Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, time: String(10 * i), labelAvailableAt: String(10 * i + 15), value: i }));
const options = { trainSize: 5, validationSize: 2, finalStart: 13, embargoMs: '5' };
test('Bend caps agree with exact reference for boundary and exhaustive small domains', () => {
  for (let a = 0; a < 15; a++) for (let b = 0; b < 15; b++) for (let c = 0; c < 15; c++) assert.equal(cappedLots(String(a), String(b), String(c)), String(Math.min(a, b, c)));
  assert.equal(cappedLots(String(MAX_NAT), String(MAX_NAT), '0'), '0');
  assert.equal(affordableLots('1000', '400', '99', '1'), '6');
  assert.throws(() => affordableLots('100', '101', '1', '0'), { code: 'RESERVATION_BREACH' });
});
test('Bend availability policies enforce every boundary and evaluation role', () => {
  for (let observed = 0; observed < 8; observed++) for (let mature = 0; mature < 8; mature++) for (let cutoff = 0; cutoff < 8; cutoff++) assert.equal(trainingAllowed({ observationTime: String(observed), labelAvailableAt: String(mature), cutoff: String(cutoff) }), observed < cutoff && mature < cutoff);
  assert.equal(canReadPartition('select', 'final'), false); assert.equal(canReadPartition('train', 'validation'), false);
  assert.equal(canReadPartition('final', 'final'), true);
  for (let i = 0; i < 5; i++) {
    const chain = ['1', '2', '3', '4', '5']; if (i < 4) chain[i] = '6';
    assert.equal(modelReady(Object.fromEntries(['labelAvailableAt', 'trainingStartedAt', 'trainingCompletedAt', 'deployedAt', 'decisionTime'].map((k, j) => [k, chain[j]]))), i === 4);
  }
});
test('walk-forward uses label maturity plus embargo and never includes final indices', () => {
  const plan = walkForwardSplits(samples, options);
  assert.deepEqual(plan.folds[0].train, [0, 1, 2]); assert.deepEqual(plan.folds[0].purged, [3, 4]);
  assert.deepEqual(plan.final, [13, 14, 15]);
  for (const fold of plan.folds) {
    for (const i of fold.train) assert.ok(BigInt(samples[i].labelAvailableAt) < BigInt(fold.cutoff));
    for (const i of [...fold.train, ...fold.validation]) assert.ok(i < 13);
  }
  assert.equal(foldRows(samples, plan, 'fold-1', 'train', 'train').rows.length, 3);
  assert.throws(() => foldRows(samples, plan, 'fold-1', 'train', 'validation'), { code: 'PARTITION_DENIED' });
  const tampered = structuredClone(plan); tampered.folds[0].train.push(14);
  assert.throws(() => foldRows(samples, tampered, 'fold-1', 'train', 'train'), { code: 'SPLIT_TAMPER' });
  assert.throws(() => walkForwardSplits(samples, { ...options, stepSize: 1 }), { code: 'SPLIT_ARGUMENT' });
  assert.throws(() => walkForwardSplits(samples, { ...options, embargoMs: '500' }), { code: 'EMPTY_TRAIN_FOLD' });
  const delayed = structuredClone(samples); delayed[0].availableAt = '1000';
  assert.deepEqual(walkForwardSplits(delayed, options).folds[0].train, [1, 2]);
});
test('persistent holdout release remains consumed when evaluation fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bend-holdout-')), plan = walkForwardSplits(samples, options);
  const input = { holdoutId: 'untouched-v1', strategyHash: hash('strategy'), protocol: { metric: 'net-pnl' }, samples, plan };
  await assert.rejects(withFinalHoldout(root, input, evaluation => { assert.equal(evaluation.rows.length, 3); throw new Error('intentional'); }), /intentional/);
  await assert.rejects(withFinalHoldout(root, { ...input, strategyHash: hash('changed') }, () => 1), { code: 'FINAL_TEST_REUSE' });
});

test('validation excludes labels and features reaching the final boundary', () => {
  for (const maturity of ['130', '135']) {
    const rows = structuredClone(samples); rows[12].labelAvailableAt = maturity;
    const plan = walkForwardSplits(rows, options), last = plan.folds.at(-1);
    assert.deepEqual(last.validation, [11]);
    assert.deepEqual(last.validationPurged, [12]);
    assert.deepEqual(foldRows(rows, plan, last.id, 'select', 'validation').rows.map(row => row.id), ['s11']);
  }
  const delayed = structuredClone(samples); delayed[11].availableAt = '130';
  assert.throws(() => walkForwardSplits(delayed, options), { code: 'EMPTY_VALIDATION_FOLD' });
  const noHoldout = walkForwardSplits(samples, { ...options, finalStart: samples.length });
  assert.deepEqual(noHoldout.folds.at(-1).validation, [13, 14]);
});
test('two independent processes cannot release the same final holdout twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bend-holdout-race-'));
  const module = new URL('../src/evaluation.mjs', import.meta.url).href;
  const input = { holdoutId: 'same', strategyHash: hash('strategy'), protocol: { metric: 'pnl' }, samples, plan: walkForwardSplits(samples, options) };
  const code = `import {withFinalHoldout} from ${JSON.stringify(module)}; try { await withFinalHoldout(${JSON.stringify(root)}, ${JSON.stringify(input)}, async () => 42); console.log('won'); } catch(e) { if(e.code !== 'FINAL_TEST_REUSE') throw e; console.log('lost'); }`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
    child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { err += x; }); child.on('error', reject);
    child.on('exit', c => c === 0 ? resolve(out.trim()) : reject(new Error(err)));
  });
  assert.deepEqual((await Promise.all([run(), run()])).sort(), ['lost', 'won']);
});
test('regular metrics reject undeclared grid and expose undefined variance', () => {
  const report = { status: 'valid-under-declared-model', dataQuality: { status: 'accepted' }, valuations: [{ time: '0', equity: '100' }, { time: '1', equity: '100' }, { time: '2', equity: '100' }] };
  assert.equal(regularReturns(report, { intervalMs: '1', periodsPerYear: 252 }).sharpe, null);
  assert.throws(() => regularReturns(report, { intervalMs: '2', periodsPerYear: 252 }), { code: 'IRREGULAR_SAMPLING' });
  const varied = { ...report, valuations: [{ time: '0', equity: '100' }, { time: '1', equity: '110' }, { time: '2', equity: '99' }] };
  assert.ok(Math.abs(regularReturns(varied, { intervalMs: '1', periodsPerYear: 252 }).sharpe) < 1e-10);
});
test('comparison retains failed trials and readonly ledger views cannot corrupt reports', () => {
  const input = JSON.parse(readFileSync(new URL('../examples/demo.json', import.meta.url), 'utf8'));
  const run = new Backtest(input.config).run(input.events), report = run.report();
  assert.throws(() => run.fills.pop(), TypeError); assert.throws(() => { run.state = {}; }, TypeError);
  assert.deepEqual(run.report(), report);
  assert.deepEqual(comparisonTable([{ id: 'b', status: 'failed', error: 'crash' }, { id: 'a', status: 'completed', report }]).map(x => [x.id, x.valid]), [['a', true], ['b', false]]);
});

test('equity sampling uses last same-time state without looking ahead and rejects stale or deficit history', () => {
  const report = { status: 'valid-under-declared-model', dataQuality: { status: 'accepted' }, valuations: [
    { time: '0', equity: '100' }, { time: '0', equity: '110' }, { time: '15', equity: '90' }, { time: '20', equity: '95' }
  ] };
  const protocol = { startTime: '0', endTime: '20', intervalMs: '10', maxStalenessMs: '10' };
  assert.deepEqual(sampleEquity(report, protocol), [{ time: '0', equity: '110' }, { time: '10', equity: '110' }, { time: '20', equity: '95' }]);
  assert.throws(() => sampleEquity(report, { ...protocol, maxStalenessMs: '9' }), { code: 'STALE_SAMPLING' });
  assert.throws(() => sampleEquity(report, { ...protocol, endTime: '21' }), { code: 'METRIC_GRID' });
  for (const equity of [null, '-1', '0']) assert.throws(() => sampleEquity({ ...report, valuations: [report.valuations[0], { time: '5', equity }, ...report.valuations.slice(2)] }, protocol), { code: 'UNDEFINED_RETURN' });
  assert.throws(() => sampleEquity({ ...report, terminal: { deficit: '1' } }, protocol), { code: 'UNDEFINED_RETURN' });
});

test('study runs every fold through real replay with historical warmup, reset accounts, baselines and no final observations', async () => {
  const instrument = { symbol: 'STUDY', currency: 'EUR', lotSize: '1', priceTick: '1' };
  const ticks = Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, type: 'tick', time: String(i * 10), sourceTime: String(i * 10), sequence: String(i + 1),
    symbol: instrument.symbol, currency: instrument.currency, bid: String(100 + i), ask: String(101 + i), bidLots: '10', askLots: '10' }));
  const rows = ticks.map(t => ({ id: t.id, time: t.time, labelAvailableAt: String(BigInt(t.time) + 1n) }));
  const plan = walkForwardSplits(rows, { trainSize: 3, validationSize: 3, finalStart: 9 });
  const protocol = { warmup: 'history-only', account: 'reset-per-fold', intervalMs: '10', periodsPerYear: 252, maxStalenessMs: '0' };
  const decisions = [], accounts = [];
  const config = { instrument, initialCash: '1000', feePerLot: '0', orderLatencyMs: '1', cancelLatencyMs: '0', maxQuoteAgeMs: '10',
    manifest: { datasetVersion: 'study-fixture', strategyArtifact: 'test', evaluationProtocol: 'validation', seed: '1' } };
  const inputSamples = structuredClone(rows), inputPlan = structuredClone(plan);
  const study = await evaluateStudy({ samples: inputSamples, plan: inputPlan, protocol }, async ({ fold, training, evaluation }) => {
    assert.equal(training.partition, 'train'); assert.equal(evaluation.partition, 'validation');
    // The admitted study owns its snapshot even across asynchronous callbacks.
    if (fold.id === 'fold-1') {
      inputSamples[6].time = '999999'; inputSamples[6].labelAvailableAt = '999999';
      inputPlan.folds[1].validation.push(11);
      await Promise.resolve();
    }
    let first = true;
    const strategy = Object.assign(context => {
      decisions.push({ fold: fold.id, time: context.time, history: context.history.length });
      if (first) { accounts.push(context.account.ledger.quantity); first = false; }
      return '1';
    }, { lookback: 3 });
    return { strategy, baselines: { cash: targetPosition('0') }, createReplay: () => ({
      informationSource: quoteInformationSource({ id: 'study-information', instrument, ticks }),
      executionVenue: new QuoteExecutionVenue({ id: 'study-venue', config, ticks, maxPositionLots: '1' })
    }) };
  });
  assert.equal(study.folds.length, plan.folds.length);
  assert.deepEqual(study.plan, plan);
  assert.equal(decisions.length, 6); assert.ok(decisions.every(row => row.history === 3 && BigInt(row.time) < 90n));
  assert.deepEqual(accounts, [0n, 0n]);
  assert.equal(study.aggregate.initialEquity, '2000'); assert.equal(study.baselines.cash.netPnl, '0');
  for (const fold of study.folds) {
    assert.ok(fold.candidate.report.fills.every(fill => BigInt(fill.decisionTime) >= BigInt(fold.startTime)));
    for (const result of [fold.candidate, ...Object.values(fold.baselines)]) {
      const reference = regularReturns({ ...result.report, valuations: sampleEquity(result.report, { ...protocol, startTime: fold.startTime, endTime: fold.endTime }) }, protocol);
      assert.equal(result.metrics.returns, undefined);
      assert.equal(result.metrics.count, reference.returns.length);
      assert.equal(result.metrics.returnsHash, hash(reference.returns));
      if (reference.sharpe === null) assert.equal(result.metrics.sharpe, null);
      else assert.ok(Math.abs(result.metrics.sharpe - reference.sharpe) < 1e-10);
    }
  }
  let callbacks = 0;
  await assert.rejects(evaluateStudy({ samples: rows, plan: inputPlan, protocol }, () => { callbacks++; }), { code: 'SPLIT_TAMPER' });
  await assert.rejects(evaluateStudy({ samples: inputSamples, plan, protocol }, () => { callbacks++; }), { code: 'DATASET_MISMATCH' });
  assert.equal(callbacks, 0, 'Reject changed input before exposing any partition');
  const selection = selectStudy([{ id: 'failed', status: 'failed', error: 'crash' }, { id: 'abandoned', status: 'abandoned' },
    { id: 'b', status: 'completed', study }, { id: 'a', status: 'completed', study: JSON.parse(JSON.stringify(study)) }]);
  assert.equal(selection.selectedId, 'a'); assert.equal(selection.population.length, 4);
  const changed = structuredClone(study); changed.aggregate.netPnl = '999999';
  assert.equal(selectStudy([{ id: 'tampered', status: 'completed', study: changed }]).selectedId, null);
  for (const corrupt of [
    value => value.folds.pop(),
    value => { value.folds[0].baselines.cash.report.status = 'invalid-data-quality'; },
    value => { delete value.folds[0].baselines.cash; },
    value => { value.aggregate.totalReturn.numerator = '99999'; },
    value => { value.baselines.cash.excessReturn.numerator = '99999'; }
  ]) {
    const invalid = structuredClone(study); corrupt(invalid); delete invalid.hash; invalid.hash = hash(invalid);
    const rejected = selectStudy([{ id: 'incomplete', status: 'completed', study: invalid }]);
    assert.equal(rejected.selectedId, null); assert.equal(rejected.population.length, 1); assert.equal(rejected.population[0].valid, false);
  }
  await assert.rejects(evaluateStudy({ samples: rows, plan, protocol }, () => ({ strategy: targetPosition('1'), baselines: { cash: targetPosition('0') },
    createReplay: ({ variant }) => ({ informationSource: quoteInformationSource({ id: 'study-information', instrument, ticks }),
      executionVenue: new QuoteExecutionVenue({ id: 'study-venue', config, ticks, maxPositionLots: variant === 'candidate' ? '1' : '2' }) }) })), { code: 'STUDY_BASELINE' });
  const incompatible = structuredClone(study); incompatible.comparisonHash = hash('different-policy'); delete incompatible.hash; incompatible.hash = hash(incompatible);
  assert.throws(() => selectStudy([{ id: 'a', status: 'completed', study }, { id: 'b', status: 'completed', study: incompatible }]), { code: 'STUDY_COMPARISON' });
});

test('disk study streams thousands of valuations into compact metrics matching the array reference', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bend-study-scale-'));
  const instrument = { symbol: 'TICKS', currency: 'EUR', lotSize: '1', priceTick: '1' };
  const ticks = Array.from({ length: 6000 }, (_, i) => ({ id: `q${i}`, type: 'tick', time: String(i), sourceTime: String(i), sequence: String(i + 1),
    symbol: instrument.symbol, currency: instrument.currency, bid: String(100 + i % 37), ask: String(101 + i % 37), bidLots: '10', askLots: '10' }));
  const rows = ticks.map(t => ({ id: t.id, time: t.time, labelAvailableAt: t.time }));
  const plan = walkForwardSplits(rows, { trainSize: 1000, validationSize: 2000, finalStart: 5000 });
  const protocol = { warmup: 'history-only', account: 'reset-per-fold', intervalMs: '1', periodsPerYear: 252, maxStalenessMs: '0' };
  const config = { instrument, initialCash: '100000', feePerLot: '0', orderLatencyMs: '1', cancelLatencyMs: '0', maxQuoteAgeMs: '1',
    manifest: { datasetVersion: 'scale-ticks', strategyArtifact: 'hold', evaluationProtocol: 'validation', seed: '1' } };
  const informationSource = quoteInformationSource({ id: 'ticks', instrument, ticks });
  const study = await evaluateStudy({ samples: rows, plan, protocol }, ({ fold }) => ({
    strategy: targetPosition('1'), baselines: { cash: targetPosition('0') },
    createReplay: ({ variant }) => ({ informationSource,
      executionVenue: new QuoteExecutionVenue({ id: 'quotes', config, ticks, maxPositionLots: '1', auditDirectory: join(directory, fold.id, variant) }) }),
  }));
  for (const fold of study.folds) for (const result of [fold.candidate, ...Object.values(fold.baselines)]) {
    assert.equal(result.report.valuations, undefined);
    const valuations = sampleEquity(result.report, { ...protocol, startTime: fold.startTime, endTime: fold.endTime });
    const reference = regularReturns({ ...result.report, valuations }, protocol);
    assert.equal(result.metrics.count, 1999);
    assert.equal(result.metrics.returnsHash, hash(reference.returns));
    assert.ok(JSON.stringify(result.metrics).length < 1000, 'Metric result size is independent of sampled grid length');
    if (reference.sharpe === null) assert.equal(result.metrics.sharpe, null);
    else assert.ok(Math.abs(result.metrics.sharpe - reference.sharpe) < 1e-10);
  }
  assert.equal(selectStudy([{ id: 'scale', status: 'completed', study }]).selectedId, 'scale');
});

test('research worker fits and evaluates every fold with common baselines and immutable artifacts', async () => {
  const artifacts = new Map();
  const result = await researchWorker({ kind: 'ridge', evaluationPartition: 'validation', parameters: { alpha: 1 } },
    { seed: '1', writeArtifact(name, data) { assert.ok(!artifacts.has(name)); artifacts.set(name, data); } });
  assert.equal(result.study.folds.length, 2);
  assert.ok(artifacts.has('fold-1/model.json') && artifacts.has('fold-2/model.json'));
  assert.deepEqual(Object.keys(result.study.baselines), ['cash', 'hold']);
  assert.equal(selectStudy([{ id: 'ridge', status: 'completed', study: result.study }]).selectedId, 'ridge');
  const other = await researchWorker({ kind: 'hold', evaluationPartition: 'validation' }, { seed: '2', writeArtifact() {} });
  const selection = selectStudy([{ id: 'ridge', status: 'completed', study: result.study }, { id: 'hold', status: 'completed', study: other.study }]);
  assert.ok(selection.population.every(trial => trial.valid), 'Strategy identities and model seeds may differ under the same execution policy');
});
