import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { freeze, hash, requireThat } from './core.mjs';
import { canonicalExperimentJson, listExperiments, readExperimentResult } from './experiments.mjs';
import { publishImmutable } from './immutable-files.mjs';
import { verifyWorkerBundle } from './worker-bundle.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const seal = body => freeze({ ...body, hash: hash(body) });
const publish = (path, value) => publishImmutable(path, canonicalExperimentJson(value) + '\n');
function verify(record, format) {
  const { hash: digest, ...body } = record;
  requireThat(body.format === format && digest === hash(body), 'PREFLIGHT_CORRUPT', 'Preflight evidence changed');
  return record;
}

function diagnosticSnapshot({ registry, key }) {
  const job = listExperiments(registry).find(row => row.key === key);
  requireThat(job?.status === 'completed' && job.bundle, 'PREFLIGHT_DIAGNOSTIC', 'Reuse requires a completed diagnostic with a frozen worker bundle');
  verifyWorkerBundle(job.bundle, { configuration: job.configuration });
  const result = readExperimentResult(registry, key), attempt = job.attempts.at(-1);
  return { job: freeze(job), result: freeze(result), pin: {
    registry: resolve(registry), key, specificationHash: job.specificationHash, configurationHash: job.configurationHash,
    bundleId: job.bundle.id, attempt: attempt.token, resultHash: attempt.resultHash, artifactHashesHash: hash(attempt.artifactHashes),
  } };
}

/** Reuse a verified diagnostic across capacity stops without rerunning or recovering it.
 * identityHash pins the caller's study/data/candidate sources; capacity policy may change.
 * Every invocation measures capacity afresh and records it before calling admit.
 * This cooperative gate does not reserve disk or replace shared queue admission.
 */
export async function withVerifiedPreflight({ directory, identityHash, diagnostic, checkCapacity }, admit) {
  requireThat(typeof identityHash === 'string' && /^[0-9a-f]{64}$/.test(identityHash), 'PREFLIGHT_IDENTITY', 'Pin the study, data and candidate source identity');
  requireThat(typeof checkCapacity === 'function' && typeof admit === 'function', 'PREFLIGHT_CAPACITY', 'Supply a fresh capacity check and admission callback');
  const root = resolve(directory), pinPath = join(root, 'diagnostic.json'), stopPath = join(root, 'stop.json');
  const { job, result, pin } = diagnosticSnapshot(diagnostic);
  const expected = seal({ format: 'campaign-preflight-v1', identityHash, diagnostic: pin });
  publish(pinPath, expected);
  const recorded = verify(read(pinPath), expected.format);
  requireThat(recorded.hash === expected.hash, 'PREFLIGHT_IDENTITY', 'Study, data, sources or completed diagnostic changed; use a new identity');
  let originalStop = null;
  try { originalStop = verify(read(stopPath), 'campaign-capacity-check-v1'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (originalStop) requireThat(originalStop.preflightHash === recorded.hash && originalStop.capacity.allowed === false,
    'PREFLIGHT_CORRUPT', 'Original stop belongs to another preflight or was not a stop');

  let capacity, failure;
  try {
    capacity = await checkCapacity({ job, result, originalStop });
    requireThat(capacity && typeof capacity.allowed === 'boolean', 'PREFLIGHT_CAPACITY', 'Capacity check must return an explicit allowed boolean and evidence');
    capacity = JSON.parse(canonicalExperimentJson(capacity));
  } catch (error) {
    failure = error;
    capacity = { allowed: false, error: { code: error.code ?? 'CAPACITY_CHECK_FAILED', message: String(error.message ?? error) } };
  }
  const check = seal({ format: 'campaign-capacity-check-v1', preflightHash: recorded.hash,
    checkedAt: new Date().toISOString(), capacity });
  const checkPath = join(root, 'checks', `${randomUUID()}.json`);
  publish(checkPath, check);
  if (!capacity.allowed) {
    publish(stopPath, check); // The first stop survives every retry and policy revision.
    if (failure) throw failure;
    requireThat(false, 'CAMPAIGN_CAPACITY', `Capacity denied admission; evidence retained at ${checkPath}`);
  }
  return admit({ job, result, capacity: check.capacity, preflightHash: recorded.hash, checkPath });
}
