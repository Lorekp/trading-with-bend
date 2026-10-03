import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deserialize, serialize } from 'node:v8';
import { evaluateStudy } from '../../src/study.mjs';
import { walkForwardSplits } from '../../src/evaluation.mjs';
import { quoteInformationSource } from '../../src/information-source.mjs';
import { QuoteExecutionVenue } from '../../src/execution-venue.mjs';
import { targetPosition } from '../../src/strategies.mjs';
import { hash } from '../../src/core.mjs';

function fixture(t, { disk = false, baselineConfig = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bend-study-resume-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const instrument = { symbol: 'RESUME', currency: 'EUR', lotSize: '1', priceTick: '1' };
  const ticks = Array.from({ length: 12 }, (_, index) => ({ id: `q${index}`, type: 'tick', time: String(index * 10), sourceTime: String(index * 10), sequence: String(index + 1),
    symbol: instrument.symbol, currency: instrument.currency, bid: String(100 + index), ask: String(101 + index), bidLots: '10', askLots: '10' }));
  const samples = ticks.map(row => ({ id: row.id, time: row.time, labelAvailableAt: String(BigInt(row.time) + 1n) }));
  const plan = walkForwardSplits(samples, { trainSize: 3, validationSize: 3, finalStart: 9 });
  const protocol = { warmup: 'history-only', account: 'reset-per-fold', intervalMs: '10', periodsPerYear: 252, maxStalenessMs: '0' };
  const config = { instrument, initialCash: '1000', feePerLot: '0', orderLatencyMs: '1', cancelLatencyMs: '0', maxQuoteAgeMs: '10',
    manifest: { datasetVersion: 'resume-fixture', strategyArtifact: 'candidate', evaluationProtocol: 'validation', seed: '23' } };
  const calls = [];
  const prepare = ({ fold, training, evaluation }) => {
    calls.push(fold.id);
    assert.ok(training.rows.every(row => row.partition === 'train'));
    assert.ok(evaluation.rows.every(row => row.partition === 'validation'));
    return { strategy: targetPosition('1'), baselines: { cash: targetPosition('0') }, metadata: { seed: 23n }, createReplay: ({ variant }) => ({
      informationSource: quoteInformationSource({ id: 'resume-information', instrument, ticks }),
      executionVenue: new QuoteExecutionVenue({ id: 'resume-venue', config: variant === 'cash' ? { ...config, ...baselineConfig } : config, ticks, maxPositionLots: '1', ...(disk ? { auditDirectory: join(root, 'audits', `${fold.id}-${variant}`) } : {}) }),
    }) };
  };
  const preparationHash = hash({ callbackContent: prepare.toString(), strategyContent: targetPosition.toString(), config, baselineConfig, ticksHash: hash(ticks), seed: '23' });
  const directory = join(root, 'attempt-one-cache');
  return { root, samples, plan, protocol, config, calls, prepare, preparationHash, directory, options: { samples, plan, protocol } };
}

async function failAfterFirstFold(f) {
  await assert.rejects(evaluateStudy({ ...f.options, resume: { directory: f.directory, preparationHash: f.preparationHash } }, context => {
    if (context.fold.id === 'fold-2') throw new Error('training interrupted');
    return f.prepare(context);
  }), /training interrupted/);
  assert.deepEqual(f.calls, ['fold-1']);
  assert.equal(readdirSync(f.directory).filter(name => name.endsWith('.json')).length, 2);
}

test('completed validation folds survive a failed attempt and resume through the same study interface with identical hashes', async t => {
  const f = fixture(t);
  const uninterrupted = await evaluateStudy(f.options, f.prepare);
  f.calls.length = 0;
  await failAfterFirstFold(f);
  const current = join(f.root, 'attempt-two-cache');
  const resumed = await evaluateStudy({ ...f.options, resume: { directory: current, preparationHash: f.preparationHash, previousDirectories: [f.directory] } }, f.prepare);
  assert.deepEqual(f.calls, ['fold-1', 'fold-2']); // Fold one was prepared only by the failed attempt.
  assert.deepEqual(resumed, uninterrupted);
  assert.equal(resumed.hash, uninterrupted.hash);
  assert.equal(resumed.comparisonHash, uninterrupted.comparisonHash);
  assert.equal(readdirSync(current).filter(name => name.endsWith('.json')).length, 3);
  const cached = await evaluateStudy({ ...f.options, resume: { directory: current, preparationHash: f.preparationHash } }, () => { throw new Error('completed folds must be reused'); });
  assert.deepEqual(cached, uninterrupted);
  const manifest = JSON.parse(readFileSync(join(current, 'manifest.json'), 'utf8'));
  assert.equal(manifest.partition, 'validation');
  assert.equal(manifest.identity.plan, undefined); // Only identity hashes; no final rows/indices.
  assert.ok(resumed.folds.every(fold => BigInt(fold.endTime) < BigInt(f.samples[f.plan.options.finalStart].time)));
});

test('resume rejects changed preparation, data and protocol identities, malformed folds and unexpected files', async t => {
  const f = fixture(t);
  await failAfterFirstFold(f);
  const resume = { directory: f.directory, preparationHash: f.preparationHash };
  await assert.rejects(evaluateStudy({ ...f.options, resume: { ...resume, preparationHash: hash({ seed: '24', executionConfig: f.config }) } }, f.prepare), { code: 'STUDY_CACHE_IDENTITY' });
  await assert.rejects(evaluateStudy({ ...f.options, protocol: { ...f.protocol, periodsPerYear: 365 }, resume }, f.prepare), { code: 'STUDY_CACHE_IDENTITY' });
  const changedSamples = f.samples.map((sample, index) => index === 0 ? { ...sample, id: 'changed-data' } : sample);
  await assert.rejects(evaluateStudy({ ...f.options, samples: changedSamples, plan: walkForwardSplits(changedSamples, f.plan.options), resume }, f.prepare), { code: 'STUDY_CACHE_IDENTITY' });
  await assert.rejects(evaluateStudy({ ...f.options, resume: { directory: f.directory } }, f.prepare), { code: 'STUDY_CACHE_INPUT' });
  const unexpected = join(f.directory, 'final.json'); writeFileSync(unexpected, '{}');
  await assert.rejects(evaluateStudy({ ...f.options, resume }, f.prepare), { code: 'STUDY_CACHE_CORRUPT' });
  rmSync(unexpected);
  const foldPath = join(f.directory, `${hash('fold-1')}.json`), committed = JSON.parse(readFileSync(foldPath, 'utf8'));
  const { checksum, ...wrongFold } = { ...committed, foldHash: 'malformed-fold-hash' };
  writeFileSync(foldPath, JSON.stringify({ ...wrongFold, checksum: hash(wrongFold) }));
  await assert.rejects(evaluateStudy({ ...f.options, resume }, f.prepare), { code: 'STUDY_CACHE_CORRUPT' });
  writeFileSync(foldPath, '{"incomplete":');
  await assert.rejects(evaluateStudy({ ...f.options, resume }, f.prepare), { code: 'STUDY_CACHE_CORRUPT' });
  assert.deepEqual(f.calls, ['fold-1']);
});

test('resuming disk folds verifies completed audit files before skipping preparation', async t => {
  const f = fixture(t, { disk: true });
  await failAfterFirstFold(f);
  const resume = { directory: f.directory, preparationHash: f.preparationHash };
  const completed = await evaluateStudy({ ...f.options, resume }, f.prepare);
  assert.deepEqual(f.calls, ['fold-1', 'fold-2']);
  const audit = completed.folds[0].candidate.report.audit;
  const manifest = JSON.parse(readFileSync(audit.manifestPath, 'utf8'));
  const file = join(dirname(audit.manifestPath), manifest.file), bytes = readFileSync(file);
  writeFileSync(file, 'corrupt audit');
  await assert.rejects(evaluateStudy({ ...f.options, resume }, f.prepare), { code: 'STUDY_CACHE_AUDIT' });
  writeFileSync(file, bytes);
  rmSync(audit.manifestPath);
  await assert.rejects(evaluateStudy({ ...f.options, resume }, f.prepare), { code: 'STUDY_CACHE_AUDIT' });
  assert.deepEqual(f.calls, ['fold-1', 'fold-2']);
});

test('completed fold admission rejects rechecksummed semantic corruption before reusing a fold', async t => {
  const f = fixture(t);
  await failAfterFirstFold(f);
  const foldPath = join(f.directory, `${hash('fold-1')}.json`), committed = JSON.parse(readFileSync(foldPath, 'utf8'));
  const current = join(f.root, 'corruption-promotion-cache');
  const resume = { directory: current, preparationHash: f.preparationHash, previousDirectories: [f.directory] };
  const mutations = [
    ['null payload', () => null],
    ['false payload', () => false],
    ['metrics', value => { value.fold.candidate.metrics.totalReturn = { numerator: '999', denominator: '1' }; }],
    ['routing', value => { value.fold.baselines.cash.report.routing.executionVenue.datasetHash = hash('different-execution-data'); }],
    ['baseline population', value => { value.baselineNames = []; }],
    ['fold identity', value => { value.fold.evaluationHash = hash('different-validation-rows'); }],
    ['missing report', value => { delete value.fold.baselines.cash.report; }],
    ['invalid structure', value => { value.fold.baselines = []; }],
  ];
  for (const [name, mutate] of mutations) {
    let value = deserialize(Buffer.from(committed.value, 'base64'));
    const replacement = mutate(value);
    if (replacement !== undefined) value = replacement;
    const { checksum, ...body } = { ...committed, value: serialize(value).toString('base64') };
    writeFileSync(foldPath, JSON.stringify({ ...body, checksum: hash(body) }));
    await assert.rejects(evaluateStudy({ ...f.options, resume }, () => { throw new Error('corrupt folds must fail admission'); }),
      { code: 'STUDY_CACHE_CORRUPT' }, name);
    assert.deepEqual(readdirSync(current), ['manifest.json'], `${name} must not be promoted`);
  }
  assert.deepEqual(f.calls, ['fold-1']);
});

test('fresh fold admission compares each actual execution configuration before returning or caching results', async t => {
  const f = fixture(t, { baselineConfig: { feePerLot: '1' } });
  await assert.rejects(evaluateStudy(f.options, f.prepare), { code: 'STUDY_BASELINE' });
  await assert.rejects(evaluateStudy({ ...f.options, resume: { directory: f.directory, preparationHash: f.preparationHash } }, f.prepare),
    { code: 'STUDY_BASELINE' });
  assert.deepEqual(readdirSync(f.directory), ['manifest.json']);
});

test('a changed fresh baseline population rejects before creating any replay', async t => {
  const f = fixture(t);
  await failAfterFirstFold(f);
  const prepare = context => {
    const prepared = f.prepare(context);
    if (context.fold.id === 'fold-2') return { ...prepared, baselines: { renamed: targetPosition('0') },
      createReplay() { throw new Error('population mismatch must reject before replay'); } };
    return prepared;
  };
  await assert.rejects(evaluateStudy(f.options, prepare), { code: 'STUDY_BASELINE' });
  await assert.rejects(evaluateStudy({ ...f.options, resume: { directory: f.directory, preparationHash: f.preparationHash } }, prepare),
    { code: 'STUDY_BASELINE' });
  assert.equal(readdirSync(f.directory).filter(name => name.endsWith('.json')).length, 2);
});
