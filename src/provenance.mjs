import { readFileSync, readdirSync } from 'node:fs';
import { hash } from './core.mjs';

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
