import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const input = fileURLToPath(new URL('../examples/demo.json', import.meta.url));
function run(cwd, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, input, ...extra], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
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
  assert.equal(readdirSync(join(root, 'output/experiments')).length, 2);
});
test('an explicit report collision fails instead of overwriting another agent output', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bend-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const results = await Promise.all([run(root, ['--out', 'same.json']), run(root, ['--out', 'same.json'])]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  assert.equal(JSON.parse(results.find(r => r.code === 1).err).code, 'EEXIST');
  const records = readdirSync(join(root, 'output/experiments')).map(file => JSON.parse(readFileSync(join(root, 'output/experiments', file), 'utf8')));
  assert.deepEqual(records.map(r => r.status).sort(), ['completed', 'failed']);
});
