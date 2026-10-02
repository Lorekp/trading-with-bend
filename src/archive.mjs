import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import Archive from '../build/archive.mjs';

export function checkArchiveBuild() {
  const evidence = JSON.parse(readFileSync(new URL('../build/verification.json', import.meta.url)));
  for (const path of ['bend/Archive.bend', 'build/archive.mjs']) {
    const digest = createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex');
    if (evidence.compiler !== 'passed' || evidence.sourceHashes?.[path] !== digest) throw new Error('Archive Bend build is stale; run npm run build');
  }
}

export function parseChecksum(text, filename) {
  const match = /^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)\r?\n?$/.exec(text);
  if (!match || match[2] !== filename) throw new Error(`Invalid or incorrectly named checksum for ${filename}`);
  return match[1].toLowerCase();
}

function words(hex) {
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('Expected a full SHA-256 digest');
  return hex.match(/.{8}/g).reduceRight((tail, word) => ({ $: 'Con', head: BigInt(`0x${word}`), tail }), { $: 'Nil' });
}

export function archiveAccepted(expected, actual, expectedBytes, actualBytes) {
  for (const value of [expectedBytes, actualBytes]) {
    if (typeof value !== 'bigint' || value < 0n || value > (1n << 48n) - 1n) throw new Error('Invalid archive size');
  }
  return Archive.accept(words(expected), words(actual), expectedBytes, actualBytes);
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
