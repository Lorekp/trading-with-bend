import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const pin = JSON.parse(readFileSync('toolchain.json', 'utf8'));
const source = resolve('.tools/bend/bend2/main.ts');
const useWsl = process.platform === 'win32' && !process.env.BEND_BIN;
const command = process.env.BEND_BIN || (useWsl ? 'wsl' : (existsSync('.tools/bun-linux-x64/bun') ? resolve('.tools/bun-linux-x64/bun') : 'bun'));
const localKernel = existsSync('.tools/lean-4.34.0-linux/bin/lean') && !process.env.BEND_BIN;
const checkKernel = process.argv.includes('--verdict') || localKernel;
const kernelEnv = localKernel ? { ...process.env, BENDTT: resolve('.tools/bendtt/bendtt') } : process.env;
const prefix = process.env.BEND_BIN ? [] : (useWsl
  ? ['-d', 'Ubuntu-24.04', '--', ...(localKernel ? ['env', 'BENDTT=.tools/bendtt/bendtt'] : []), './.tools/bun-linux-x64/bun', '.tools/bend/bend2/main.ts']
  : [source]);
function run(args) {
  const result = spawnSync(command, [...prefix, ...args], { encoding: 'utf8', env: useWsl ? process.env : kernelEnv });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Bend failed (${result.status}): ${args.join(' ')}`);
}
mkdirSync('build', { recursive: true });
const lockPath = resolve('build/.build-lock.json');
const token = randomUUID();
try { writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }), { flag: 'wx' }); }
catch (error) {
  if (error.code === 'EEXIST') throw new Error('BUILD_BUSY: another build owns build/.build-lock.json. If it crashed, verify its PID is stopped before removing only that lock file.');
  throw error;
}
process.on('exit', () => {
  try { if (JSON.parse(readFileSync(lockPath, 'utf8')).token === token) unlinkSync(lockPath); } catch {}
});
const proofSources = () => Object.fromEntries(['LAWS.bend', 'PROOF.bend', ...readdirSync('bend').filter(name => name.endsWith('.bend')).map(name => `bend/${name}`)].sort().map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
// Invalidate evidence even if the compiler or its revision cannot be resolved.
writeFileSync('build/verification.json', JSON.stringify({ compiler: 'not-checked', kernel: 'not-checked' }));
const sourceSnapshot = JSON.stringify(proofSources());
if (!process.env.BEND_BIN) {
  if (!existsSync(source)) throw new Error('Missing pinned compiler. Run scripts/setup.ps1 or follow README.md.');
  const rev = spawnSync('git', ['-C', '.tools/bend', 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (rev.status !== 0 || rev.stdout.trim() !== pin.bendRevision) throw new Error('Bend revision differs from toolchain.json');
  const dirty = spawnSync('git', ['-C', '.tools/bend', 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error('Pinned Bend compiler checkout has tracked modifications');
}
run(['PROOF.bend', '--check-only']);
if (checkKernel) {
  if (localKernel) {
    const result = spawnSync(useWsl ? 'wsl' : 'bash', useWsl ? ['-d', 'Ubuntu-24.04', '--', 'bash', 'scripts/build-kernel.sh'] : ['scripts/build-kernel.sh'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Kernel build failed: ${result.error || result.status}`);
  }
  run(['PROOF.bend', '--verdict']);
}
for (const module of ['Engine', 'Policy', 'Archive']) {
  const staged = `build/${module.toLowerCase()}-${token}.mjs`;
  run([`bend/${module}.bend`, '-o', staged]);
  renameSync(staged, `build/${module.toLowerCase()}.mjs`);
}
if (JSON.stringify(proofSources()) !== sourceSnapshot) throw new Error('BUILD_SOURCE_CHANGED: Bend sources changed during verification; retry on a stable checkout');
const verificationPath = `build/verification-${token}.json`;
writeFileSync(verificationPath, JSON.stringify({
  compiler: 'passed', kernel: checkKernel ? 'passed' : 'not-checked',
  toolchain: process.env.BEND_BIN ? { ...pin, bendRevision: 'external-unverified', bendVersion: 'external-unverified' } : pin, backend: 'javascript',
  sourceHashes: Object.fromEntries(['bend/Engine.bend', 'bend/Policy.bend', 'bend/Archive.bend', 'LAWS.bend', 'PROOF.bend', 'build/engine.mjs', 'build/policy.mjs', 'build/archive.mjs', 'scripts/build.mjs', 'toolchain.json'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  kernelHash: checkKernel && localKernel ? createHash('sha256').update(readFileSync('.tools/bendtt/bendtt')).digest('hex') : null
}, null, 2));
renameSync(verificationPath, 'build/verification.json');
