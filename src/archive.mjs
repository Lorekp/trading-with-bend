import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { bendRuntime } from './bend-runtime.mjs';

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export const crcUpdate = (crc, bytes) => { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc >>> 0; };

export { verifyBendRuntime as checkArchiveBuild } from './bend-runtime.mjs';

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
  return bendRuntime().archive.accept(words(expected), words(actual), expectedBytes, actualBytes);
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
