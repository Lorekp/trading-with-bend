import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Integration scenarios use the real compiled Bend backend, files, CLIs and
// separate worker processes. Older focused regressions remain available under
// test:regression; new behavior should be covered through complete workflows.
const files = [
  ...readdirSync('tests/e2e').filter(file => file.endsWith('.test.mjs')).sort().map(file => `tests/e2e/${file}`),
  'tests/experiments.test.mjs', 'tests/cli-concurrency.test.mjs', 'tests/ml-execution.test.mjs', 'tests/integrity.test.mjs', 'tests/proof-mutations.test.mjs',
];
const env = { ...process.env };
if (env.BINANCE_REAL_DATA === undefined && existsSync('data/binance/um/ETHUSDT/2026-09/manifest.json')) env.BINANCE_REAL_DATA = '1';
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
