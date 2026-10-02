import { readFileSync, readdirSync } from 'node:fs';
import { canonical, freeze, hash, requireThat } from './core.mjs';

function toolkitFiles(directory = 'src') {
  return readdirSync(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === '__pycache__' ? [] : toolkitFiles(path);
    return entry.isFile() && /\.(mjs|py)$/.test(entry.name) ? [path] : [];
  });
}

export function sourceManifest() {
  const paths = ['LAWS.bend', 'PROOF.bend', 'scripts/build.mjs', 'build/engine.mjs', 'build/policy.mjs', 'build/archive.mjs', 'toolchain.json', 'package.json',
    ...toolkitFiles(),
    ...readdirSync(new URL('../bend/', import.meta.url)).filter(name => name.endsWith('.bend')).map(name => `bend/${name}`)].sort();
  return Object.fromEntries(paths.map(path => [path, hash(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))]));
}

// Event-sourced checkpoints depend on the checked Bend build and its replay host.
// Reports and experiments retain the full toolkit identity above. Research/CLI
// changes require a fresh process, but do not change replay compatibility.
export function checkpointSources(sources) {
  const host = ['src/core.mjs', 'src/framework.mjs', 'src/bend-runtime.mjs', 'src/provenance.mjs'];
  return Object.fromEntries(Object.entries(sources).filter(([path]) =>
    host.includes(path) || !path.startsWith('src/') && path !== 'package.json'));
}

// Pin evidence when toolkit modules load. Readers may inspect a registry without
// a build; operations requiring runtime evidence surface the captured failure.
// Never recapture after disk edits: building requires a fresh process.
let loadedSources, loadError;
try { loadedSources = sourceManifest(); } catch (error) { loadError = error; }
export function runtimeProvenance() {
  if (loadError) throw loadError;
  return structuredClone(loadedSources);
}

// Shared admission gate for execution, standalone policies and experiment work.
// Merely importing metadata must not require a generated Bend runtime.
export function verifiedRuntimeProvenance() {
  const sources = runtimeProvenance(), current = sourceManifest();
  requireThat(canonical(current) === canonical(sources), 'STALE_RUNTIME', 'Toolkit changed after module loading; restart the process');
  const verification = JSON.parse(readFileSync(new URL('../build/verification.json', import.meta.url), 'utf8'));
  const checkedPaths = Object.keys(sources).filter(path => !path.startsWith('src/') && path !== 'package.json').sort();
  requireThat(verification.compiler === 'passed' && verification.sourceHashes &&
    canonical(Object.keys(verification.sourceHashes).sort()) === canonical(checkedPaths) &&
    checkedPaths.every(path => verification.sourceHashes[path] === sources[path]),
  'STALE_BUILD', 'Run npm run build: build evidence must cover every checked source and generated module');
  return freeze({ sources, verification });
}
