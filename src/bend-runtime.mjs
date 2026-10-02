import engine from '../build/engine.mjs';
import policy from '../build/policy.mjs';
import archive from '../build/archive.mjs';
import { freeze } from './core.mjs';
import { verifiedRuntimeProvenance } from './provenance.mjs';

let runtime;

// New backtests and archive loads check disk freshness. Existing operations keep
// their loaded implementation and evidence, just as a running ledger does.
export function verifyBendRuntime() {
  runtime = freeze({ engine, policy, archive, ...verifiedRuntimeProvenance() });
  return runtime;
}

// Check before the first standalone policy/archive call, then reuse the verified
// implementation without filesystem work on each lot cap or training sample.
export function bendRuntime() {
  return runtime ?? verifyBendRuntime();
}
