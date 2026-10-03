import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { hashFile } from './archive.mjs';
import { hash, nat, json, requireThat, freeze } from './core.mjs';
import { verifiedRuntimeProvenance } from './provenance.mjs';
import { InformationSource, prepareInformationSource, validateObservation } from './information-source.mjs';
import { dataVisible } from './policies.mjs';
import { containedPath, textLines, verifyMarketFile, unchangedFile } from './market-archives.mjs';

const SCHEMA = 'processed-market-data-v1';
async function writeManifest(directory, manifest) {
  await writeFile(join(directory, 'manifest.json.tmp'), json(manifest));
  await rename(join(directory, 'manifest.json.tmp'), join(directory, 'manifest.json'));
}

/** Raw input is immutable. One exclusively owned directory holds each processing attempt. */
export async function prepareMarketData({ source, outputDirectory }) {
  requireThat(source?.manifest && typeof source.records === 'function', 'DATA_SOURCE', 'Require an opened market-data source');
  const root = resolve(outputDirectory), rawRoot = resolve(source.manifest.rawDirectory), part = relative(rawRoot, root);
  requireThat(part === '..' || part.startsWith('..' + sep) || isAbsolute(part), 'DATA_OUTPUT', 'Processed output must be outside the raw dataset directory');
  const runtime = verifiedRuntimeProvenance();
  const recipe = { source: structuredClone(source.manifest), processor: runtime,
    dependencyLockHash: hash(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8')),
    policy: { ordering: 'reject regressions; never sort', duplicates: 'drop identical stable identities; reject conflicting duplicates',
      missing: 'record gaps; never fill', partition: 'UTC observation day', numeric: 'exact decimal/BigInt' } };
  const recipeHash = hash(recipe);
  await mkdir(dirname(root), { recursive: true });
  const actualPart = relative(await realpath(rawRoot), join(await realpath(dirname(root)), relative(dirname(root), root)));
  requireThat(actualPart === '..' || actualPart.startsWith('..' + sep) || isAbsolute(actualPart), 'DATA_OUTPUT', 'Output parent resolves inside the raw dataset');
  try { await mkdir(root); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = await processedManifest(join(root, 'manifest.json'), { allowGaps: true }); } catch {}
    requireThat(existing?.status === 'complete' && existing.recipeHash === recipeHash, 'DATA_OUTPUT_EXISTS', 'Output is owned, failed, or uses another recipe; retain it and choose a new directory');
    for (const file of existing.files) await verifyMarketFile(root, file);
    return existing;
  }
  const manifest = { schema: SCHEMA, status: 'processing', recipe, recipeHash, files: [], rows: 0,
    quality: { identicalDuplicatesDropped: 0, missingBuckets: 0, gapRanges: [], gapRangesTruncated: false, coverage: 'observed-only' } };
  await writeManifest(root, manifest);
  let writer, previousTime = null, previousAvailable = null, previousIdentity = null, previousEncoded = null;
  const step = source.manifest.expectedStepMs === null ? null : BigInt(source.manifest.expectedStepMs);
  const start = BigInt(source.manifest.window.startTime), end = BigInt(source.manifest.window.endTime);
  let nextBucket = step === null ? null : start / step;
  const gap = (first, last) => {
    if (last <= first) return;
    manifest.quality.missingBuckets += Number(last - first);
    if (manifest.quality.gapRanges.length < 1000) manifest.quality.gapRanges.push({ startTime: String(first * step), endTime: String(last * step) });
    else manifest.quality.gapRangesTruncated = true;
  };
  async function closeShard() {
    if (!writer) return;
    writer.gzip.end(); await writer.done;
    await rename(writer.partial, writer.path);
    manifest.files.push({ path: writer.name, status: 'verified', bytes: (await stat(writer.path)).size, sha256: await hashFile(writer.path),
      rows: writer.rows, firstTime: writer.firstTime, lastTime: writer.lastTime });
    writer = null;
  }
  try {
    for await (const record of source.records()) {
      const available = validateObservation(record, previousAvailable), time = nat(record.time, 'observation time');
      requireThat(time >= start && time < end && (previousTime === null || time >= previousTime), 'DATA_ORDER', 'Observations must be ordered inside the requested UTC window');
      const identity = record.data.eventId ?? record.time, encoded = JSON.stringify(record);
      if (identity === previousIdentity) {
        requireThat(encoded === previousEncoded, 'DATA_DUPLICATE', `Conflicting duplicate identity ${identity}`);
        manifest.quality.identicalDuplicatesDropped++; continue;
      }
      previousIdentity = identity; previousEncoded = encoded; previousTime = time; previousAvailable = available;
      if (step !== null) {
        const bucket = time / step;
        if (bucket >= nextBucket) { gap(nextBucket, bucket); nextBucket = bucket + 1n; }
      }
      const day = new Date(Number(time)).toISOString().slice(0, 10), name = `${day}.jsonl.gz`;
      if (writer?.name !== name) {
        await closeShard();
        const path = join(root, name), partial = path + '.part', gzip = createGzip({ level: 6 });
        const done = pipeline(gzip, createWriteStream(partial, { flags: 'wx' }));
        // Attach immediately; the awaited promise still propagates write failures.
        done.catch(() => {});
        writer = { name, path, partial, gzip, done, rows: 0, firstTime: record.time };
      }
      if (!writer.gzip.write(encoded + '\n')) await once(writer.gzip, 'drain');
      writer.rows++; writer.lastTime = record.time; manifest.rows++;
    }
    requireThat(manifest.rows > 0, 'DATA_EMPTY', 'No observations selected');
    if (step !== null) { gap(nextBucket, (end + step - 1n) / step); manifest.quality.coverage = manifest.quality.missingBuckets ? 'gaps' : 'complete-minute-buckets'; }
    await closeShard();
    manifest.status = 'complete';
    manifest.datasetHash = hash({ recipeHash, files: manifest.files, rows: manifest.rows, quality: manifest.quality });
    await writeManifest(root, manifest); return manifest;
  } catch (error) {
    if (writer) { writer.gzip.destroy(); await writer.done.catch(() => {}); }
    manifest.status = 'failed'; manifest.error = { code: error.code ?? 'DATA_PROCESSING', message: error.message };
    await writeManifest(root, manifest); throw error;
  }
}

export async function processedManifest(manifestPath, { allowGaps = false } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  requireThat(manifest.schema === SCHEMA && manifest.status === 'complete' && manifest.recipeHash === hash(manifest.recipe)
    && manifest.datasetHash === hash({ recipeHash: manifest.recipeHash, files: manifest.files, rows: manifest.rows, quality: manifest.quality }),
  'DATA_MANIFEST', 'Require a complete, consistent processed manifest');
  requireThat(allowGaps || manifest.quality.missingBuckets === 0, 'DATA_GAPS', 'Dataset has gaps; explicitly allow them or select another dataset');
  return manifest;
}

/** Verified bounded-memory reads. Time filtering never changes availability. */
export async function* readProcessedData({ manifestPath, startTime = '0', endTime = '281474976710655', allowGaps = false }) {
  const manifest = await processedManifest(manifestPath, { allowGaps }), directory = dirname(resolve(manifestPath));
  const start = nat(startTime, 'startTime'), end = nat(endTime, 'endTime');
  requireThat(start < end, 'DATA_RANGE', 'Require startTime < endTime');
  let previous = null;
  for (const file of manifest.files) {
    if (BigInt(file.lastTime) < start || BigInt(file.firstTime) >= end) continue;
    const verified = await verifyMarketFile(directory, file);
    const input = createReadStream(containedPath(directory, file.path)), gunzip = createGunzip();
    input.on('error', error => gunzip.destroy(error)); input.pipe(gunzip);
    let rows = 0;
    try {
      for await (const { line } of textLines(gunzip)) {
        const record = JSON.parse(line); previous = validateObservation(record, previous); rows++;
        const time = BigInt(record.time);
        if (time >= start && time < end) yield freeze(record);
      }
      requireThat(rows === file.rows, 'DATA_ROWS', 'Processed shard row count mismatch');
      await unchangedFile(verified);
    } finally { input.destroy(); gunzip.destroy(); }
  }
}

/** Admit processed shards into a reusable source; disk admission bounds memory. */
export async function loadProcessedInformationSource(options) {
  const manifest = await processedManifest(options.manifestPath, options);
  const source = { id: `processed:${manifest.recipe.source.venue}:${manifest.recipe.source.kind}`,
    instrument: manifest.recipe.source.instrument, datasetHash: manifest.datasetHash };
  if (options.directory !== undefined) {
    requireThat(options.maxRows === undefined, 'DATA_SIZE', 'maxRows applies only to in-memory loading; omit it when preparing a directory');
    return prepareInformationSource({ ...source, observations: readProcessedData(options), directory: options.directory });
  }
  const observations = [], maxRows = options.maxRows ?? 100000;
  requireThat(Number.isSafeInteger(maxRows) && maxRows > 0, 'DATA_SIZE', 'maxRows must be a positive integer');
  for await (const record of readProcessedData(options)) {
    requireThat(observations.length < maxRows, 'DATA_SIZE', 'Use streaming reads for larger datasets'); observations.push(record);
  }
  return new InformationSource({ ...source, observations });
}

/** Inclusive as-of lookup; stale/missing observations are explicit nulls. */
export async function* asOfMarketData(records, decisions, { maxAgeMs }) {
  const age = nat(maxAgeMs, 'maxAgeMs'), iterator = records[Symbol.asyncIterator]?.() ?? records[Symbol.iterator]();
  let next, latest = null, previousAvailable = null, previousDecision = null;
  const advance = async () => { const item = await iterator.next(); if (!item.done) previousAvailable = validateObservation(item.value, previousAvailable); return item; };
  try {
    next = await advance();
    for await (const decisionTime of decisions) {
      const decision = nat(decisionTime, 'decisionTime');
      requireThat(previousDecision === null || decision >= previousDecision, 'DATA_ORDER', 'Decision times must not regress'); previousDecision = decision;
      while (!next.done && dataVisible(next.value.availableAt, decisionTime)) { latest = next.value; next = await advance(); }
      const fresh = latest !== null && decision - BigInt(latest.time) <= age;
      yield freeze({ decisionTime, observation: fresh ? structuredClone(latest) : null, reason: fresh ? null : latest ? 'stale' : 'unavailable' });
    }
  } finally { await iterator.return?.(); }
}
