import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveAccepted, parseChecksum, checkArchiveBuild } from '../src/archive.mjs';

test('Bend archive admission rejects corruption in every digest word and wrong sizes', () => {
  checkArchiveBuild();
  const digest = '01234567'.repeat(8);
  assert.equal(archiveAccepted(digest, digest, 100n, 100n), true);
  for (let i = 0; i < 64; i++) {
    const changed = digest.slice(0, i) + (digest[i] === 'f' ? '0' : 'f') + digest.slice(i + 1);
    assert.equal(archiveAccepted(digest, changed, 100n, 100n), false);
  }
  assert.equal(archiveAccepted(digest, digest, 100n, 99n), false);
  assert.equal(archiveAccepted(digest, digest, 0n, 0n), false);
  assert.throws(() => archiveAccepted(digest.slice(1), digest, 100n, 100n));
});
test('checksum must bind a complete digest to the exact archive filename', () => {
  const digest = 'a'.repeat(64);
  assert.equal(parseChecksum(`${digest}  ETHUSDT.zip\n`, 'ETHUSDT.zip'), digest);
  assert.throws(() => parseChecksum(`${digest}  OTHER.zip\n`, 'ETHUSDT.zip'));
  assert.throws(() => parseChecksum(`${digest.slice(1)}  ETHUSDT.zip`, 'ETHUSDT.zip'));
  assert.throws(() => parseChecksum(`${digest}  ETHUSDT.zip\nextra`, 'ETHUSDT.zip'));
});
