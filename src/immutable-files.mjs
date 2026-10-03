import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Publish complete bytes once on a local filesystem supporting hard links.
 * Returns false if another publisher already owns the destination. */
export function publishImmutable(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.publish-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx');
    writeFileSync(fd, bytes);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temporary, path); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
