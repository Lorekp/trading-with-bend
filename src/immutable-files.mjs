import { randomUUID } from 'node:crypto';
import { closeSync, constants, linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Node permissions disable fsync, so synchronize each write at open time.
// Windows omits constants.O_SYNC, but libuv's public UV_FS_O_SYNC flag maps to
// FILE_FLAG_WRITE_THROUGH on both supported Node lines (22 and 24):
// https://github.com/nodejs/node/blob/v24.21.0/deps/uv/include/uv/win.h
// https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/win/fs.c
const syncFlag = process.platform === 'win32' ? 0x08000000 : constants.O_SYNC;

/** Publish complete bytes once on a local filesystem supporting hard links.
 * Returns false if another publisher already owns the destination. */
export function publishImmutable(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.publish-${randomUUID()}.tmp`);
  let fd;
  try {
    if (!Number.isInteger(syncFlag)) throw Object.assign(new Error('Synchronized file writes are unsupported on this platform'), { code: 'SYNC_UNSUPPORTED' });
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | syncFlag);
    writeFileSync(fd, bytes);
    closeSync(fd); fd = undefined;
    try { linkSync(temporary, path); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
