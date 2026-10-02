import test from 'node:test';
import assert from 'node:assert/strict';
import { gridJobs, parameterGrid } from '../src/search.mjs';
test('parameter grids are stable, bounded and contain no silent duplicate trials', () => {
  assert.deepEqual(parameterGrid({ b: [1, 2], a: ['x'] }), [{ a: 'x', b: 1 }, { a: 'x', b: 2 }]);
  assert.deepEqual(parameterGrid({}), [{}]);
  assert.throws(() => parameterGrid({ a: [1, 1] }), { code: 'GRID_DUPLICATE' });
  assert.throws(() => parameterGrid({ a: [] }), { code: 'GRID_SPACE' });
  assert.throws(() => parameterGrid({ a: [1, 2], b: [1, 2] }, { maxTrials: 3 }), { code: 'GRID_LIMIT' });
});
test('job keys/seeds are independent of scheduling and parameter property order', () => {
  const input = { namespace: 'agent-a/test', workerModule: 'worker.mjs', baseConfiguration: { dataset: 'v1' }, space: { alpha: [1, 2], beta: [3] } };
  const a = gridJobs(input), b = gridJobs({ ...input, space: { beta: [3], alpha: [1, 2] } });
  assert.deepEqual(a, b); assert.notEqual(a[0].key, a[1].key);
  assert.throws(() => gridJobs({ ...input, partition: 'final' }), { code: 'SEARCH_PARTITION' });
  a[0].configuration.dataset = 'changed'; assert.equal(a[1].configuration.dataset, 'v1');
});
