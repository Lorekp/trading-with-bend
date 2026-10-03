import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical, freeze, hash, requireThat } from './core.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const filePath = value => value instanceof URL || typeof value === 'string' && value.startsWith('file:') ? fileURLToPath(value) : resolve(value);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const inside = (root, path) => { const name = relative(root, path); return name !== '' && !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`); };

function regularPath(path, directory = false) {
  const absolute = resolve(path);
  // realpath checks parent junctions too without requiring permission to inspect
  // unrelated ancestor directories in a constrained child.
  const actual = realpathSync(absolute), normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  requireThat(!lstatSync(absolute).isSymbolicLink() && normalize(actual) === normalize(absolute), 'BUNDLE_SYMLINK', `Bundle paths cannot contain symlinks: ${path}`);
  requireThat(directory ? lstatSync(absolute).isDirectory() : lstatSync(absolute).isFile(), 'BUNDLE_FILE', `Expected a regular ${directory ? 'directory' : 'file'}: ${path}`);
  return absolute;
}

function digestFile(path) {
  regularPath(path);
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try { let size; while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
}

function filesIn(directory, prefix = '') {
  regularPath(directory, true);
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = `${prefix}${entry.name}`, path = join(directory, entry.name);
    requireThat(!entry.isSymbolicLink(), 'BUNDLE_SYMLINK', `Bundle paths cannot contain symlinks: ${path}`);
    return entry.isDirectory() ? filesIn(path, `${name}/`) : (regularPath(path), [name]);
  });
}

function safeRelative(name) {
  requireThat(typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes('\0') && !name.includes(':') && !isAbsolute(name) && name.split('/').every(part => part && part !== '.' && part !== '..'),
    'BUNDLE_PATH', `Unsafe bundle-relative path: ${name}`);
  return name;
}

function provenanceAt(root) {
  const url = pathToFileURL(join(root, 'src/provenance.mjs')).href;
  const script = `import { verifiedRuntimeProvenance } from ${JSON.stringify(url)}; console.log(JSON.stringify({ ...verifiedRuntimeProvenance(), node:process.version, platform:process.platform, architecture:process.arch }));`;
  const result = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${root}`, '--input-type=module', '--eval', script], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  requireThat(result.status === 0, 'BUNDLE_BUILD', `Bundle requires a verified build: ${result.stderr || result.error?.message || result.status}`);
  return JSON.parse(result.stdout);
}

function installedFiles(sourceRoot) {
  const lock = readJson(join(sourceRoot, 'package-lock.json')), names = new Set();
  requireThat(lock.lockfileVersion >= 2 && lock.packages, 'BUNDLE_LOCK', 'A package lock with package records is required');
  for (const [name, record] of Object.entries(lock.packages)) {
    if (!name) continue;
    safeRelative(name);
    requireThat(name.startsWith('node_modules/') && !record.link, 'BUNDLE_LOCK', 'Linked or external installed packages are unsupported');
    const path = join(sourceRoot, name);
    if (!existsSync(path) && (record.optional || record.peer)) continue;
    requireThat(existsSync(path), 'BUNDLE_DEPENDENCY', `Run npm ci before freezing: missing ${name}`);
    const installed = readJson(regularPath(join(path, 'package.json')));
    requireThat(installed.version === record.version, 'BUNDLE_DEPENDENCY', `Installed version does not match package lock: ${name}`);
    for (const child of filesIn(path)) names.add(`${name}/${child}`);
  }
  for (const name of Object.keys(readJson(join(sourceRoot, 'package.json')).dependencies ?? {})) {
    requireThat(names.has(`node_modules/${name}/package.json`), 'BUNDLE_DEPENDENCY', `Missing direct dependency: ${name}`);
  }
  return [...names].sort();
}

function inputField(configuration, pointer) {
  requireThat(typeof pointer === 'string' && pointer.startsWith('/') && !/~(?![01])/.test(pointer), 'BUNDLE_INPUT', 'Input files use explicit JSON pointers into configuration');
  const keys = pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
  let parent = configuration;
  for (const key of keys.slice(0, -1)) {
    requireThat(parent && typeof parent === 'object' && Object.hasOwn(parent, key), 'BUNDLE_INPUT', `Missing input configuration field: ${pointer}`);
    parent = parent[key];
  }
  const key = keys.at(-1);
  requireThat(parent && typeof parent === 'object' && Object.hasOwn(parent, key) && typeof parent[key] === 'string', 'BUNDLE_INPUT', `Input configuration field must be a file path: ${pointer}`);
  return { parent, key };
}

function snapshotInput(registryRoot, path) {
  const sourceHash = digestFile(path), directory = join(registryRoot, '.worker-inputs', sourceHash), target = join(directory, 'data');
  mkdirSync(directory, { recursive: true }); regularPath(directory, true);
  if (!existsSync(target)) {
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      copyFileSync(path, temporary);
      requireThat(digestFile(temporary) === sourceHash, 'BUNDLE_CHANGED', 'Input changed while creating its immutable snapshot');
      const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      // Concurrent publishers carry identical bytes; never replace an existing snapshot.
      try { linkSync(temporary, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { rmSync(temporary, { force: true }); }
  }
  requireThat(digestFile(target) === sourceHash, 'BUNDLE_CORRUPT', 'Stored input snapshot was modified');
  // Archive readers dispatch on .zip/.tar.gz, so retain the declared filename.
  // Aliases link only to our completed immutable copy, never to the source data.
  const names = join(directory, 'files'), named = join(names, basename(path));
  mkdirSync(names, { recursive: true }); regularPath(names, true);
  try { linkSync(target, named); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  requireThat(digestFile(named) === sourceHash, 'BUNDLE_CORRUPT', 'Stored named input snapshot was modified');
  return { path: named, hash: sourceHash };
}

function bundleDependencies(path, manifest) {
  return Object.fromEntries([
    ...manifest.dependencies.map(name => [pathToFileURL(join(path, safeRelative(name))).href, manifest.files[name]]),
    ...Object.values(manifest.inputs).map(input => [pathToFileURL(input.path).href, input.hash]),
  ]);
}

/**
 * Freeze the verified toolkit, installed dependencies, entrypoint and declared
 * helpers without changing their relative import layout. inputFiles maps JSON
 * pointers to source paths; only those explicitly declared fields are remapped.
 * Large input bytes are copied once per content identity, never linked to source.
 */
export function createWorkerBundle(registryRoot, { workerModule, dependencies = [], configuration, inputFiles = {}, sourceRoot = repository }) {
  sourceRoot = regularPath(sourceRoot, true); registryRoot = resolve(registryRoot);
  requireThat(Array.isArray(dependencies), 'BUNDLE_DEPENDENCY', 'dependencies must be local file paths');
  requireThat(inputFiles && Object.getPrototypeOf(inputFiles) === Object.prototype, 'BUNDLE_INPUT', 'inputFiles must map JSON pointers to local file paths');
  const original = provenanceAt(sourceRoot), files = new Set([...Object.keys(original.sources), 'build/verification.json', ...installedFiles(sourceRoot)]);
  const inputSources = new Set(Object.values(inputFiles).map(filePath));
  const entrypoint = regularPath(filePath(workerModule)), dependencyPaths = [...new Set(dependencies.map(value => regularPath(filePath(value))))].filter(path => !inputSources.has(path));
  for (const path of [entrypoint, ...dependencyPaths]) {
    requireThat(inside(sourceRoot, path), 'BUNDLE_PATH', 'Worker entrypoint and helpers must be inside sourceRoot; declare external datasets through inputFiles');
    files.add(relative(sourceRoot, path).split(sep).join('/'));
  }
  const mapped = structuredClone(configuration), inputs = {};
  for (const [pointer, value] of Object.entries(inputFiles).sort(([a], [b]) => a.localeCompare(b))) {
    const field = inputField(mapped, pointer), path = regularPath(filePath(value));
    requireThat(filePath(field.parent[field.key]) === path, 'BUNDLE_INPUT', `Declared input does not match configuration: ${pointer}`);
    inputs[pointer] = snapshotInput(registryRoot, path);
    field.parent[field.key] = inputs[pointer].path;
  }
  const manifests = Object.fromEntries([...files].sort().map(name => [safeRelative(name), digestFile(join(sourceRoot, name))]));
  requireThat(!Object.hasOwn(manifests, 'bundle.json'), 'BUNDLE_PATH', 'bundle.json is reserved for snapshot identity');
  for (const [name, sourceHash] of Object.entries(original.sources)) requireThat(manifests[name] === sourceHash, 'BUNDLE_CHANGED', 'Toolkit changed while freezing');
  const manifest = { version: 1, node: process.version, platform: process.platform, architecture: process.arch, files: manifests,
    worker: relative(sourceRoot, entrypoint).split(sep).join('/'), dependencies: dependencyPaths.map(path => relative(sourceRoot, path).split(sep).join('/')).sort(), inputs,
    provenance: original };
  const id = hash(manifest), directory = join(registryRoot, '.worker-bundles'), path = join(directory, id);
  mkdirSync(directory, { recursive: true }); regularPath(directory, true);
  if (!existsSync(path)) {
    const staging = join(directory, `${id}.${randomUUID()}.tmp`);
    mkdirSync(staging);
    try {
      for (const [name, sourceHash] of Object.entries(manifests)) {
        const target = join(staging, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(sourceRoot, name), target);
        requireThat(digestFile(target) === sourceHash, 'BUNDLE_CHANGED', 'A source or installed dependency changed while freezing');
      }
      requireThat(canonical(provenanceAt(staging)) === canonical(original), 'BUNDLE_CHANGED', 'Frozen toolkit evidence does not match its source');
      writeFileSync(join(staging, 'bundle.json'), canonical(manifest), { flag: 'wx' });
      try { renameSync(staging, path); } catch (error) { if (!existsSync(path)) throw error; }
    } finally {
      requireThat(inside(directory, staging), 'BUNDLE_PATH', 'Bundle staging cleanup must stay within its bundle store');
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const bundle = freeze({ version: 1, id, path, workerModule: pathToFileURL(join(path, manifest.worker)).href,
    dependencies: bundleDependencies(path, manifest), inputFiles: inputs, provenance: original });
  verifyWorkerBundle(bundle);
  return { bundle, configuration: mapped };
}

/** Verify every byte and reject undeclared files before and after execution. */
export function verifyWorkerBundle(bundle) {
  requireThat(bundle?.version === 1 && /^[0-9a-f]{64}$/.test(bundle.id), 'BUNDLE_CORRUPT', 'Invalid bundle descriptor');
  regularPath(bundle.path, true);
  const manifest = readJson(regularPath(join(bundle.path, 'bundle.json')));
  requireThat(hash(manifest) === bundle.id, 'BUNDLE_CORRUPT', 'Bundle manifest does not match its identity');
  requireThat(manifest.node === process.version && manifest.platform === process.platform && manifest.architecture === process.arch, 'BUNDLE_RUNTIME', 'Bundle requires its recorded Node version, platform and architecture');
  requireThat(bundle.workerModule === pathToFileURL(join(bundle.path, safeRelative(manifest.worker))).href && canonical(bundle.provenance) === canonical(manifest.provenance) && canonical(bundle.inputFiles) === canonical(manifest.inputs)
    && canonical(bundle.dependencies) === canonical(bundleDependencies(bundle.path, manifest)),
  'BUNDLE_CORRUPT', 'Bundle descriptor does not match its manifest');
  const names = filesIn(bundle.path).filter(name => name !== 'bundle.json');
  requireThat(canonical(names.sort()) === canonical(Object.keys(manifest.files).sort()), 'BUNDLE_CORRUPT', 'Bundle contains missing or undeclared files');
  for (const [name, expected] of Object.entries(manifest.files)) requireThat(digestFile(join(bundle.path, safeRelative(name))) === expected, 'BUNDLE_CORRUPT', `Frozen file changed: ${name}`);
  for (const input of Object.values(manifest.inputs)) requireThat(digestFile(input.path) === input.hash, 'BUNDLE_CORRUPT', 'Frozen input changed');
  return manifest;
}

/**
 * Node permissions reduce accidental filesystem access; this is not a hostile
 * code or network sandbox. Constrained workers cannot launch Python, processes,
 * native addons or worker threads. Trusted work can explicitly opt out.
 */
export function workerBundleExecution(bundle, { jobPath, attemptPath, constrained = true }) {
  verifyWorkerBundle(bundle);
  requireThat(typeof constrained === 'boolean', 'BUNDLE_PERMISSION', 'constrained must be explicitly true or false');
  jobPath = regularPath(jobPath, true); attemptPath = regularPath(attemptPath, true);
  requireThat(inside(join(jobPath, 'attempts'), attemptPath), 'BUNDLE_PATH', 'Attempt must be inside its own job attempts directory');
  const claims = regularPath(join(jobPath, 'claims'), true);
  requireThat(!inside(jobPath, bundle.path) && !inside(bundle.path, jobPath) && bundle.path !== jobPath, 'BUNDLE_PATH', 'Bundle and writable job paths must be separate');
  const execArgv = constrained ? ['--permission', ...[bundle.path, jobPath, ...Object.values(bundle.inputFiles).map(input => input.path)].map(path => `--allow-fs-read=${path}`),
    `--allow-fs-write=${attemptPath}`, `--allow-fs-write=${claims}`] : [];
  return { workerScript: join(bundle.path, 'src/experiment-worker.mjs'), cwd: bundle.path, execArgv };
}
