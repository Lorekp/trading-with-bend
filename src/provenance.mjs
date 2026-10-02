import { readFileSync, readdirSync } from 'node:fs';
import { canonical, freeze, hash, requireThat } from './core.mjs';

export function sourceManifest() {
  const paths = ['LAWS.bend', 'PROOF.bend', 'scripts/build.mjs', 'build/engine.mjs', 'build/policy.mjs', 'build/archive.mjs', 'toolchain.json', 'package.json',
    ...readdirSync(new URL('../src/', import.meta.url)).filter(name => name.endsWith('.mjs')).map(name => `src/${name}`),
    ...readdirSync(new URL('../bend/', import.meta.url)).filter(name => name.endsWith('.bend')).map(name => `bend/${name}`)].sort();
  return Object.fromEntries(paths.map(path => [path, hash(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))]));
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
