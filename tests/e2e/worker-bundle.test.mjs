import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, hash } from '../../src/core.mjs';
import { sourceManifest } from '../../src/provenance.mjs';
import { createWorkerBundle, verifyWorkerBundle, workerBundleExecution } from '../../src/worker-bundle.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bend-worker-bundle-')), sourceRoot = join(root, 'checkout'), registry = join(root, 'registry');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of [...Object.keys(sourceManifest()), 'build/verification.json']) {
    const path = join(sourceRoot, name); mkdirSync(dirname(path), { recursive: true }); copyFileSync(join(repository, name), path);
  }
  cpSync(join(repository, 'node_modules'), join(sourceRoot, 'node_modules'), { recursive: true });
  const helper = join(sourceRoot, 'experiments/test/helper.mjs'), worker = join(sourceRoot, 'experiments/test/worker.mjs');
  mkdirSync(dirname(worker), { recursive: true });
  writeFileSync(helper, 'export const value = 7;\n');
  writeFileSync(worker, "import { value } from './helper.mjs';\nimport { readFileSync, writeFileSync } from 'node:fs';\nimport tar from 'tar-stream';\nexport default async function(configuration, context) { const stream = tar.pack(); stream.destroy(); const data = readFileSync(configuration.data.file,'utf8'); let denied; try { readFileSync(configuration.hidden,'utf8'); } catch(error) { denied=error.code; } let writeDenied; try { writeFileSync(new URL('./helper.mjs',import.meta.url),'mutation'); } catch(error) { writeDenied=error.code; } context.writeArtifact('result.json', { value, data, denied, writeDenied }); return { value, data, denied, writeDenied, note:configuration.note }; }\n");
  const data = join(root, 'dataset.json'), hidden = join(root, 'holdout.json');
  writeFileSync(data, 'training'); writeFileSync(hidden, 'final');
  return { root, registry, sourceRoot, worker, helper, data, hidden };
}

async function execute(bundle, configuration, registry, key = randomUUID()) {
  const jobPath = join(registry, 'jobs', hash(key)), token = randomUUID(), attemptPath = join(jobPath, 'attempts', token);
  mkdirSync(attemptPath, { recursive: true }); mkdirSync(join(jobPath, 'claims'), { recursive: true });
  const specification = { version: 2, key, configuration, configurationHash: hash(configuration), execution: 'worker', workerModule: bundle.workerModule,
    workerHash: fileHash(fileURLToPath(bundle.workerModule)), dependencies: bundle.dependencies, toolkit: bundle.provenance, seed: 3 };
  writeFileSync(join(jobPath, 'manifest.json'), canonical({ ...specification, specificationHash: hash(specification), createdAt: new Date().toISOString() }));
  const execution = workerBundleExecution(bundle, { jobPath, attemptPath });
  const child = fork(execution.workerScript, [registry, key, token, String(process.pid), '0', String(Date.now() + 15000), '{}'],
    { cwd: execution.cwd, execArgv: execution.execArgv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', response;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.on('message', message => { response = message; });
  const timeout = setTimeout(() => child.kill(), 15000);
  child.send({ start: true });
  const status = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  clearTimeout(timeout);
  assert.equal(status, 0, `${output}\n${JSON.stringify(response)}`);
  assert.equal(response?.success, true);
  return response.result;
}

test('real frozen workers survive checkout edits, preserve package imports and deny holdout reads and snapshot writes', async t => {
  const f = fixture(t), configuration = { data: { file: f.data }, hidden: f.hidden, note: f.data };
  const frozen = createWorkerBundle(f.registry, { sourceRoot: f.sourceRoot, workerModule: f.worker, dependencies: [f.helper, f.data], configuration, inputFiles: { '/data/file': f.data } });
  assert.notEqual(frozen.configuration.data.file, f.data);
  assert.ok(frozen.configuration.data.file.endsWith('dataset.json'));
  assert.equal(frozen.configuration.note, f.data); // Unrelated strings are never rewritten.
  writeFileSync(f.worker, 'export default () => ({ value: 999 });\n');
  writeFileSync(f.helper, 'export const value = 999;\n');
  writeFileSync(join(f.sourceRoot, 'src/core.mjs'), 'throw new Error("checkout mutated");\n');
  writeFileSync(f.data, 'changed original data');
  assert.deepEqual(await execute(frozen.bundle, frozen.configuration, f.registry), { value: 7, data: 'training', denied: 'ERR_ACCESS_DENIED', writeDenied: 'ERR_ACCESS_DENIED', note: f.data });
  verifyWorkerBundle(frozen.bundle);
});

test('bundle identity deduplicates datasets, retains exact file membership and rejects tampering', t => {
  const f = fixture(t), request = { sourceRoot: f.sourceRoot, workerModule: f.worker, dependencies: [f.helper], configuration: { data: { file: f.data } }, inputFiles: { '/data/file': f.data } };
  const first = createWorkerBundle(f.registry, request), again = createWorkerBundle(f.registry, request);
  assert.equal(first.bundle.id, again.bundle.id);
  writeFileSync(f.helper, 'export const value = 8;\n');
  const changed = createWorkerBundle(f.registry, request);
  assert.notEqual(first.bundle.id, changed.bundle.id);
  assert.equal(first.bundle.inputFiles['/data/file'].path, changed.bundle.inputFiles['/data/file'].path);
  writeFileSync(join(first.bundle.path, 'unexpected.mjs'), 'export const hidden = 1;\n');
  assert.throws(() => verifyWorkerBundle(first.bundle), { code: 'BUNDLE_CORRUPT' });
  rmSync(join(first.bundle.path, 'unexpected.mjs'));
  writeFileSync(join(first.bundle.path, 'experiments/test/helper.mjs'), 'export const value = 9;\n');
  assert.throws(() => verifyWorkerBundle(first.bundle), { code: 'BUNDLE_CORRUPT' });
  writeFileSync(changed.bundle.inputFiles['/data/file'].path, 'mutated snapshot');
  assert.throws(() => verifyWorkerBundle(changed.bundle), { code: 'BUNDLE_CORRUPT' });
});

test('freezing rejects mismatched declared inputs and imports outside the checkout', t => {
  const f = fixture(t);
  assert.throws(() => createWorkerBundle(f.registry, { sourceRoot: f.sourceRoot, workerModule: f.worker, configuration: { file: f.hidden }, inputFiles: { '/file': f.data } }), { code: 'BUNDLE_INPUT' });
  assert.throws(() => createWorkerBundle(f.registry, { sourceRoot: f.sourceRoot, workerModule: f.hidden, configuration: {} }), { code: 'BUNDLE_PATH' });
  assert.throws(() => createWorkerBundle(f.registry, { sourceRoot: f.sourceRoot, workerModule: f.worker, dependencies: [f.data], configuration: {} }), { code: 'BUNDLE_PATH' });
  const linked = join(f.sourceRoot, 'experiments/linked');
  symlinkSync(dirname(f.worker), linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createWorkerBundle(f.registry, { sourceRoot: f.sourceRoot, workerModule: join(linked, 'worker.mjs'), configuration: {} }), { code: 'BUNDLE_SYMLINK' });
});
