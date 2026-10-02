import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listExperiments, readExperimentResult, verifyExperimentArtifacts } from '../src/experiments.mjs';
import { hash } from '../src/core.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const input = fileURLToPath(new URL('../examples/demo.json', import.meta.url));
function run(cwd, extra = [], inputPath = input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, inputPath, ...extra], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; }); child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
}
test('concurrent CLI runs create distinct reports and retain both experiment records', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bend-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const results = await Promise.all([run(root), run(root)]);
  assert.deepEqual(results.map(r => r.code), [0, 0]);
  const paths = results.map(r => JSON.parse(r.out).report); assert.notEqual(paths[0], paths[1]);
  for (const path of paths) assert.equal(JSON.parse(readFileSync(join(root, path), 'utf8')).performance.netPnl, '260');
  const registry = join(root, 'output/experiments');
  assert.deepEqual(listExperiments(registry).map(record => record.status), ['completed', 'completed']);
  for (const result of results) {
    const { experimentId, report } = JSON.parse(result.out);
    const saved = JSON.parse(readFileSync(join(root, report), 'utf8'));
    assert.deepEqual(readExperimentResult(registry, experimentId), saved);
    assert.deepEqual(Object.keys(verifyExperimentArtifacts(registry, experimentId)).sort(), ['inputs.json', 'raw-input.json']);
    rmSync(join(root, report));
    assert.deepEqual(readExperimentResult(registry, experimentId), saved, 'Registry owns its result independently of the exported report');
  }
});
test('an explicit report collision fails instead of overwriting another agent output', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bend-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const results = await Promise.all([run(root, ['--out', 'same.json']), run(root, ['--out', 'same.json'])]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  assert.equal(JSON.parse(results.find(r => r.code === 1).err).code, 'EEXIST');
  const records = listExperiments(join(root, 'output/experiments'));
  assert.deepEqual(records.map(r => r.status).sort(), ['completed', 'failed']);
  assert.deepEqual(listExperiments(join(root, 'output/experiments')).map(record => record.status).sort(), ['completed', 'failed']);
});

test('malformed CLI input retains its raw evidence and failed attempt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bend-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const malformed = join(root, 'malformed.json'), raw = '{invalid json';
  writeFileSync(malformed, raw);
  const result = await run(root, [], malformed);
  assert.equal(result.code, 1);
  const registry = join(root, 'output/experiments'), [record] = listExperiments(registry);
  assert.equal(record.status, 'failed');
  assert.deepEqual(JSON.parse(readFileSync(join(record.attempts[0].outputDirectory, 'raw-input.json'), 'utf8')), { rawHash: hash(raw) });
  assert.throws(() => readExperimentResult(registry, record.key), { code: 'RESULT_UNAVAILABLE' });
});
