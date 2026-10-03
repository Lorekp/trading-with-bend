import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import tar from 'tar-stream';
import { archiveAccepted, checkArchiveBuild, crcUpdate, hashFile } from './archive.mjs';
import { requireThat } from './core.mjs';

export function containedPath(directory, name) {
  requireThat(typeof name === 'string' && !isAbsolute(name), 'DATA_PATH', 'Data paths must be relative');
  const path = resolve(directory, name), part = relative(resolve(directory), path);
  requireThat(part !== '' && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part), 'DATA_PATH', 'Data path escapes its dataset directory');
  return path;
}

export async function verifyMarketFile(directory, file) {
  requireThat(file.status === 'verified' && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes > 0,
    'DATA_MANIFEST', 'Data files require verified status, SHA-256 and byte length');
  const path = containedPath(directory, file.path), actualPath = await realpath(path), root = await realpath(directory);
  containedPath(root, relative(root, actualPath));
  const before = await stat(path);
  requireThat(before.isFile(), 'DATA_FILE', 'Expected a regular data file');
  checkArchiveBuild();
  requireThat(archiveAccepted(file.sha256, await hashFile(path), BigInt(file.bytes), BigInt(before.size)), 'ARCHIVE_INTEGRITY', `Hash/size mismatch: ${file.path}`);
  return { path, before };
}

export async function unchangedFile({ path, before }) {
  const after = await stat(path);
  requireThat(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino,
    'ARCHIVE_INTEGRITY', 'Data file changed during processing');
}

/** Bounded UTF-8 line decoder; never silently fixes malformed bytes or giant rows. */
export async function* textLines(stream, onChunk = () => {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', lineNumber = 0;
  for await (const chunk of stream) {
    onChunk(chunk); pending += decoder.decode(chunk, { stream: true });
    let start = 0, end;
    while ((end = pending.indexOf('\n', start)) >= 0) {
      const line = pending.slice(start, end);
      requireThat(line.length <= 1024 * 1024, 'DATA_LINE', 'Market-data row exceeds 1 MiB');
      yield { line: line.endsWith('\r') ? line.slice(0, -1) : line, lineNumber: ++lineNumber }; start = end + 1;
    }
    pending = pending.slice(start);
    requireThat(pending.length <= 1024 * 1024, 'DATA_LINE', 'Market-data row exceeds 1 MiB');
  }
  pending += decoder.decode();
  if (pending) yield { line: pending.endsWith('\r') ? pending.slice(0, -1) : pending, lineNumber: ++lineNumber };
}

/** Verified streaming ZIP/ZIP64 and tar.gz input. No files are extracted. */
export async function* marketArchiveLines(directory, file) {
  const verified = await verifyMarketFile(directory, file);
  let bytes = 0, entries = 0;
  const count = chunk => { bytes += chunk.length; requireThat(bytes <= 64 * 1024 ** 3, 'DATA_SIZE', 'Archive exceeds the 64 GiB inflated limit'); };
  if (file.path.endsWith('.zip')) {
    const zip = await yauzl.openPromise(verified.path, { lazyEntries: true, strictFileNames: true });
    try {
      for await (const entry of zip.eachEntry()) {
        if (entry.fileName.endsWith('/')) continue;
        requireThat(entry.fileName.endsWith('.csv') && entry.uncompressedSize <= 64 * 1024 ** 3, 'DATA_ARCHIVE', 'Expected a bounded CSV entry');
        let crc = 0xffffffff, size = 0; entries++;
        const input = await zip.openReadStreamPromise(entry);
        for await (const row of textLines(input, chunk => { count(chunk); size += chunk.length; crc = crcUpdate(crc, chunk); })) yield { ...row, entry: entry.fileName };
        requireThat(size === entry.uncompressedSize && ((crc ^ 0xffffffff) >>> 0) === entry.crc32, 'ZIP_CRC', 'ZIP payload CRC/size mismatch');
      }
    } finally { zip.close(); }
  } else {
    requireThat(file.path.endsWith('.tar.gz'), 'DATA_ARCHIVE', 'Only ZIP and tar.gz archives are supported');
    const extract = tar.extract(), input = createReadStream(verified.path), gunzip = createGunzip();
    let pumpError;
    const pumping = pipeline(input, gunzip, extract).catch(error => { pumpError = error; });
    try {
      for await (const entry of extract) {
        if (entry.header.type === 'directory') { for await (const chunk of entry) count(chunk); continue; }
        requireThat(entry.header.type === 'file', 'DATA_ARCHIVE', 'Links and special TAR entries are unsupported');
        entries++;
        for await (const row of textLines(entry, count)) yield { ...row, entry: entry.header.name };
      }
      await pumping; if (pumpError) throw pumpError;
    } finally { input.destroy(); gunzip.destroy(); extract.destroy(); await pumping; }
  }
  requireThat(entries > 0, 'DATA_ARCHIVE', 'Empty market archive');
  await unchangedFile(verified);
}
