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
