import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const demo = JSON.parse(readFileSync(join(root, 'examples/demo.json'), 'utf8'));
const projectFiles = [
  'scripts/build.mjs', 'toolchain.json', 'package.json', 'LAWS.bend', 'PROOF.bend',
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
  for (const folder of runtime ? ['src', 'bend', 'build'] : ['src']) cpSync(join(root, folder), join(directory, folder), { recursive: true });
  return directory;
}

const load = (directory, file) => import(pathToFileURL(join(directory, file)).href);
const hasCode = expected => error => error?.code === expected;

test('data, features, parameter grids and registry readers work without a build or repository metadata', async t => {
  const directory = copyProject(t, { runtime: false });
  const { parseQuoteCsv, QUOTE_UNITS } = await load(directory, 'src/data.mjs');
  const { computeFeatures } = await load(directory, 'src/features.mjs');
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
    const { runExperiment } = await load(directory, 'src/research.mjs');
    const { hash } = await load(directory, 'src/core.mjs');
    const configuration = { lookback: 10, model: { fold: 'training-1' } };
    const original = structuredClone(configuration);
    const records = join(directory, 'experiments');
    let recordPath;
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
      recordPath = join(records, `${id}.json`);
    }
    // A failing trial still has one completed audit record with its original inputs.
    const files = readdirSync(records);
    assert.equal(files.length, 1);
    const record = JSON.parse(readFileSync(recordPath || join(records, files[0]), 'utf8'));
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
