import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const demo = JSON.parse(readFileSync(join(root, 'examples/demo.json'), 'utf8'));
const projectFiles = [
  'scripts/build.mjs', 'toolchain.json', 'package.json', 'LAWS.bend', 'PROOF.bend',
  'build/engine.mjs', 'build/policy.mjs', 'build/archive.mjs', 'build/verification.json',
];

function copyProject(t, { runtime = true } = {}) {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'bend-integrity-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.ok(basename(directory).startsWith('bend-integrity-'));
    rmSync(directory, { recursive: true, force: true });
  });
  for (const file of runtime ? projectFiles : []) {
    const destination = join(directory, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, file), destination);
  }
  // Build can contain other worktrees; copy its artifacts explicitly above.
  for (const folder of runtime ? ['src', 'bend'] : ['src']) cpSync(join(root, folder), join(directory, folder), { recursive: true });
  return directory;
}

const load = (directory, file) => import(pathToFileURL(join(directory, file)).href);
const hasCode = expected => error => error?.code === expected;

test('data, features, parameter grids and registry readers work without a build or repository metadata', async t => {
  const directory = copyProject(t, { runtime: false });
  const { parseQuoteCsv, QUOTE_UNITS } = await load(directory, 'src/data.mjs');
  const { computeFeatures } = await load(directory, 'src/features.mjs');
  const { sequenceSamples } = await load(directory, 'src/sequence-data.mjs');
  const { parameterGrid } = await load(directory, 'src/search.mjs');
  const { enqueueExperiment, listExperiments } = await load(directory, 'src/experiments.mjs');
  const instrument = { symbol: 'TEST', currency: 'EUR', lotSize: '1', priceTick: '1' };
  const quotes = parseQuoteCsv('time,bid,ask,bidLots,askLots\n0,99,100,1,1\n1,101,102,1,1\n', {
    instrument, units: QUOTE_UNITS, columns: { time: 'time', bid: 'bid', ask: 'ask', bidLots: 'bidLots', askLots: 'askLots' },
  });
  const features = computeFeatures(quotes.map(q => ({ time: q.time, availableAt: q.time, values: { price: Number(q.bid) } })),
    [{ name: 'mean', source: 'price', kind: 'mean', window: 2, unit: 'quote-minor-per-lot' }]);
  assert.equal(features[0].ready, false);
  assert.deepEqual(features[1].values, [100]);
  const sequence = sequenceSamples({
    observations: features.map((feature, i) => ({ feature, price: Number(quotes[i].bid) })),
    schema: [{ name: 'mean', source: 'price', kind: 'mean', window: 2, unit: 'quote-minor-per-lot' }],
    instrument: 'TEST', venue: 'fixture', sequenceLength: 1, horizonSteps: 1, intervalMs: '1',
  });
  assert.deepEqual(sequence.latest.feature.values, [100]);
  assert.deepEqual(parameterGrid({ window: [2, 4] }), [{ window: 2 }, { window: 4 }]);
  const registry = join(directory, 'registry');
  assert.deepEqual(listExperiments(registry), []);
  const worker = join(directory, 'worker.mjs');
  writeFileSync(worker, 'export default () => ({});');
  assert.throws(() => enqueueExperiment(registry, { key: 'requires-evidence', configuration: {}, workerModule: worker }), hasCode('ENOENT'));
  assert.deepEqual(listExperiments(registry), [], 'Missing runtime evidence must not publish a job');
});

for (const fails of [false, true]) {
  test(`experiment preserves registered configuration when ${fails ? 'failed' : 'successful'} work mutates its input`, async t => {
    const directory = copyProject(t);
    const { runExperiment, listExperiments, readExperimentResult } = await load(directory, 'src/experiments.mjs');
    const { hash } = await load(directory, 'src/core.mjs');
    const configuration = { lookback: 10, model: { fold: 'training-1' } };
    const original = structuredClone(configuration);
    const records = join(directory, 'experiments');
    const work = () => {
      configuration.lookback = 20;
      configuration.model.fold = 'training-2';
      if (fails) throw new Error('deliberate trial failure');
      return { score: 1 };
    };
    if (fails) {
      assert.throws(() => runExperiment(records, configuration, work), /deliberate trial failure/);
    } else {
      const { id } = runExperiment(records, configuration, work);
      assert.deepEqual(readExperimentResult(records, id), { score: 1 });
    }
    // A failing trial still has one completed audit record with its original inputs.
    const population = listExperiments(records);
    assert.equal(population.length, 1);
    const [record] = population;
    assert.deepEqual(record.configuration, original);
    assert.equal(record.configurationHash, hash(original));
    assert.equal(record.configurationHash, hash(record.configuration));
    assert.equal(record.status, fails ? 'failed' : 'completed');
  });
}

test('live runs retain original source and verification evidence after disk edits', async t => {
  const directory = copyProject(t);
  const { Backtest } = await load(directory, 'src/framework.mjs');
  const run = new Backtest(demo.config).run(demo.events);
  const originalReport = run.report();
  const originalCheckpoint = run.checkpoint();

  appendFileSync(join(directory, 'bend/Engine.bend'), '\n# Changed after this process loaded the engine.\n');
  const verificationPath = join(directory, 'build/verification.json');
  const verification = JSON.parse(readFileSync(verificationPath, 'utf8'));
  verification.compiler = 'not-checked';
  verification.kernel = originalReport.softwareChecks.bendKernel === 'passed' ? 'not-checked' : 'passed';
  verification.toolchain = { ...verification.toolchain, bendRevision: 'changed-after-run' };
  writeFileSync(verificationPath, JSON.stringify(verification));

  assert.deepEqual(run.report(), originalReport);
  assert.deepEqual(run.checkpoint(), originalCheckpoint);
  assert.throws(() => new Backtest(demo.config), hasCode('STALE_RUNTIME'));
  assert.throws(() => Backtest.resume(originalCheckpoint), hasCode('CHECKPOINT_VERSION'));
});

test('a freshly loaded runtime rejects source changes absent from build evidence', async t => {
  const directory = copyProject(t);
  appendFileSync(join(directory, 'bend/Engine.bend'), '\n# Edited before module import without rebuilding.\n');
  const { Backtest } = await load(directory, 'src/framework.mjs');
  assert.throws(() => new Backtest(demo.config), hasCode('STALE_BUILD'));
});

test('checkpoints survive research and CLI edits in a fresh runtime but reject replay host changes', async t => {
  const original = copyProject(t);
  const { Backtest } = await load(original, 'src/framework.mjs');
  const run = new Backtest(demo.config).run(demo.events.slice(0, 3));
  const checkpoint = run.checkpoint();
  const expected = run.run(demo.events.slice(3)).report();
  for (const file of ['src/cli.mjs', 'src/ml/forecast.py', 'src/framework.mjs', 'src/core.mjs']) {
    const directory = copyProject(t);
    appendFileSync(join(directory, file), '\n');
    const { Backtest: Reloaded } = await load(directory, 'src/framework.mjs');
    if (file === 'src/framework.mjs' || file === 'src/core.mjs') {
      assert.throws(() => Reloaded.resume(checkpoint), hasCode('CHECKPOINT_VERSION'));
    } else {
      const actual = Reloaded.resume(checkpoint).run(demo.events.slice(3)).report();
      assert.deepEqual(actual.ledger, expected.ledger);
      assert.deepEqual(actual.fills, expected.fills);
      assert.equal(actual.traceHash, expected.traceHash);
      assert.notEqual(actual.manifest.sourceHashes[file], expected.manifest.sourceHashes[file]);
    }
  }
});

test('toolkit provenance automatically pins nested Python implementation changes', async t => {
  const directory = copyProject(t);
  const { runtimeProvenance } = await load(directory, 'src/provenance.mjs');
  const { enqueueExperiment, listExperiments } = await load(directory, 'src/experiments.mjs');
  assert.match(runtimeProvenance()['src/ml/forecast.py'], /^[a-f0-9]{64}$/);
  appendFileSync(join(directory, 'src/ml/forecast.py'), '\n');
  const worker = join(directory, 'worker.mjs'), registry = join(directory, 'registry');
  writeFileSync(worker, 'export default () => ({});');
  assert.throws(() => enqueueExperiment(registry, { key: 'changed-backend', configuration: {}, workerModule: worker }), hasCode('STALE_RUNTIME'));
  assert.deepEqual(listExperiments(registry), []);
});

// Exercise the real compiled runtime through its callers. No Backtest or queue
// starts before the standalone model, split and archive workflows are checked.
async function runtimeWorkflows(directory) {
  const { computeFeatures } = await load(directory, 'src/features.mjs');
  const { fitRidge, predictRidge } = await load(directory, 'src/models.mjs');
  const { walkForwardSplits } = await load(directory, 'src/evaluation.mjs');
  const { archiveAccepted } = await load(directory, 'src/archive.mjs');
  const { Backtest } = await load(directory, 'src/framework.mjs');
  const { runExperiment, listExperiments, readExperimentResult } = await load(directory, 'src/experiments.mjs');
  const schema = [{ name: 'price', source: 'price', kind: 'value', unit: 'quote-minor-per-lot' }];
  const features = computeFeatures([10, 11, 12].map((price, i) => ({ time: String(i), availableAt: String(i), values: { price } })), schema);
  const rows = features.map((feature, i) => ({ id: `train-${i}`, partition: 'train', feature, target: 0.01, labelAvailableAt: String(i + 1) }));
  const samples = Array.from({ length: 8 }, (_, i) => ({ id: `sample-${i}`, time: String(i * 10), labelAvailableAt: String(i * 10 + 1) }));
  const registry = join(directory, 'registry');
  return {
    train() {
      const model = fitRidge({ rows, schema, fold: 'standalone', cutoff: '4', trainingStartedAt: '4', trainingCompletedAt: '5', deployedAt: '5' });
      return predictRidge({ model, schema, fold: model.fold, decisionTime: '5', feature: features[2] });
    },
    split: () => walkForwardSplits(samples, { trainSize: 3, validationSize: 2, finalStart: 7 }),
    archive: () => archiveAccepted('a'.repeat(64), 'a'.repeat(64), 100n, 100n),
    replay: () => new Backtest(demo.config).run(demo.events).report(),
    register: () => runExperiment(registry, demo.config, () => new Backtest(demo.config).run(demo.events).report()),
    list: () => listExperiments(registry),
    result: key => readExperimentResult(registry, key),
  };
}

test('standalone training, splits, archive admission and registered replay use a verified runtime', async t => {
  const study = await runtimeWorkflows(copyProject(t));
  assert.ok(Math.abs(study.train().prediction - 0.01) < 1e-12);
  assert.equal(study.split().folds.length, 2);
  assert.equal(study.archive(), true);
  assert.equal(study.replay().performance.netPnl, '260');
  const { id } = study.register();
  assert.equal(study.list()[0].status, 'completed');
  assert.deepEqual(study.result(id), study.replay());
});

for (const changed of ['failed-build', 'empty-evidence', 'missing-policy-evidence', 'bend/Policy.bend', 'build/policy.mjs', 'build/archive.mjs', 'LAWS.bend']) {
  test(`all runtime entry paths reject ${changed} before executing work`, async t => {
    const directory = copyProject(t);
    if (changed.includes('/') || changed === 'LAWS.bend') appendFileSync(join(directory, changed), '\n');
    else {
      const path = join(directory, 'build/verification.json'), evidence = JSON.parse(readFileSync(path, 'utf8'));
      if (changed === 'failed-build') evidence.compiler = 'not-checked';
      else if (changed === 'empty-evidence') evidence.sourceHashes = {};
      else delete evidence.sourceHashes['build/policy.mjs'];
      writeFileSync(path, JSON.stringify(evidence));
    }
    const study = await runtimeWorkflows(directory);
    for (const name of ['train', 'split', 'archive', 'replay', 'register']) assert.throws(study[name], hasCode('STALE_BUILD'), name);
    assert.deepEqual(study.list(), [], 'Rejected work must not publish a manifest');
  });
}

test('runtime changes between import and first policy use cannot acquire fresh evidence', async t => {
  const directory = copyProject(t), study = await runtimeWorkflows(directory);
  appendFileSync(join(directory, 'build/policy.mjs'), '\n');
  for (const name of ['train', 'split', 'archive', 'replay', 'register']) assert.throws(study[name], hasCode('STALE_RUNTIME'), name);
  assert.deepEqual(study.list(), []);
});

test('verified policy operations stay pinned while new execution admissions reject changed sources', async t => {
  const directory = copyProject(t), study = await runtimeWorkflows(directory);
  const original = study.train();
  appendFileSync(join(directory, 'bend/Policy.bend'), '\n');
  assert.deepEqual(study.train(), original, 'Loaded policy implementation and evidence remain paired');
  assert.equal(study.archive(), true);
  assert.throws(study.replay, hasCode('STALE_RUNTIME'));
  assert.throws(study.register, hasCode('STALE_RUNTIME'));
  const { checkArchiveBuild } = await load(directory, 'src/archive.mjs');
  assert.throws(checkArchiveBuild, hasCode('STALE_RUNTIME'));
});
