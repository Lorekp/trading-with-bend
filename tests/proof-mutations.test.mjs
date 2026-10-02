import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

test('Bend specification gate rejects deliberate accounting, cap and leakage regressions', { timeout: 120000 }, () => {
  const parent = resolve('build'), directory = join(parent, `proof-mutation-${randomUUID()}`);
  mkdirSync(directory);
  const mutations = [
    ['bend/Engine.bend', 'Nat.sub(cash, cost(price, lots, fee))', 'Nat.sub(cash, Nat.mul(price, lots))', 'buy_updates_ledger_exactly'],
    ['bend/Policy.bend', 'Nat.min(requested, Nat.min(capital, position))', 'requested', 'capped_lots_respects_all_limits'],
    ['bend/Policy.bend', 'case Select{} Holdout{}:\n      False{}', 'case Select{} Holdout{}:\n      True{}', 'selection_cannot_read_final'],
    ['bend/Policy.bend', 'Bool.and(Nat.is_lt(observed, cutoff), Nat.is_lt(mature, cutoff))', 'Nat.is_lt(observed, cutoff)', 'unavailable_labels_are_excluded']
  ];
  try {
    for (const [file, from, to, expectedLaw] of mutations) {
      for (const file of ['LAWS.bend', 'PROOF.bend']) copyFileSync(file, join(directory, file));
      cpSync('bend', join(directory, 'bend'), { recursive: true });
      const path = join(directory, file), source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
      assert.ok(source.includes(from), `Mutation target still exists: ${from}`);
      writeFileSync(path, source.replace(from, to));
      const input = join(directory, 'PROOF.bend');
      let command, args;
      if (process.env.BEND_BIN) { command = process.env.BEND_BIN; args = [input, '--check-only']; }
      else if (process.platform === 'win32') {
        command = 'wsl';
        const wslPath = input.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
        args = ['-d', 'Ubuntu-24.04', '--', './.tools/bun-linux-x64/bun', '.tools/bend/bend2/main.ts', wslPath, '--check-only'];
      } else { command = resolve('.tools/bun-linux-x64/bun'); args = ['.tools/bend/bend2/main.ts', input, '--check-only']; }
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 25000 });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, `Incorrect implementation passed: ${from}`);
      assert.match(result.stdout + result.stderr, /SOME PROOFS FAIL/, 'Failure must come from the proof gate');
      assert.ok((result.stdout + result.stderr).includes(expectedLaw), `Failure must identify the relevant law ${expectedLaw}`);
    }
  } finally {
    assert.equal(dirname(directory), parent); rmSync(directory, { recursive: true, force: true });
  }
});
