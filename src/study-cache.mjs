import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { canonical, freeze, hash, requireThat } from './core.mjs';
import { openReplayAudit } from './recording.mjs';
import { publishImmutable } from './immutable-files.mjs';

function read(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')), { checksum, ...body } = record;
    requireThat(checksum === hash(body), 'STUDY_CACHE_CORRUPT', 'Study cache checksum changed');
    return body;
  } catch (error) {
    throw Object.assign(new Error(`Study cache record is incomplete or corrupt: ${path}`, { cause: error }), { code: 'STUDY_CACHE_CORRUPT' });
  }
}

function publish(path, body) {
  publishImmutable(path, canonical({ ...body, checksum: hash(body) }));
  return read(path);
}

function verifyAudits(value) {
  const results = [value.fold.candidate, ...Object.values(value.fold.baselines)];
  requireThat(results.every(result => result?.report), 'STUDY_CACHE_CORRUPT', 'Every completed fold variant must have a report');
  for (const result of results) {
    if (!result.report.audit) continue;
    try {
      const audit = openReplayAudit(result.report);
      try { for (const stream of Object.keys(audit.manifest.streams)) for (const row of audit.records(stream)) void row; }
      finally { audit.close(); }
    } catch (error) {
      throw Object.assign(new Error('Completed fold audit is missing or changed', { cause: error }), { code: 'STUDY_CACHE_AUDIT' });
    }
  }
}

// Internal persistence seam. evaluateStudy remains the caller/test interface.
// A directory owns one validation identity, never arbitrary process state.
function openCacheDirectory(directory, identity, foldIds, readOnly) {
  requireThat(typeof directory === 'string' && directory.length > 0, 'STUDY_CACHE_INPUT', 'Declare a cache directory');
  directory = resolve(directory);
  if (!readOnly) mkdirSync(directory, { recursive: true });
  const actual = realpathSync(directory), normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  requireThat(normalize(actual) === normalize(directory) && !lstatSync(directory).isSymbolicLink(), 'STUDY_CACHE_CORRUPT', 'Study cache directory cannot contain symlinks');
  const manifestPath = join(directory, 'manifest.json'), specification = { format: 'validation-fold-cache-v1', partition: 'validation', identity, foldIds };
  const manifest = readOnly ? read(manifestPath) : publish(manifestPath, specification);
  requireThat(hash(manifest) === hash(specification), 'STUDY_CACHE_IDENTITY', 'Cache belongs to a different data, plan, protocol, preparation or runtime identity; use a new cache directory');
  const identityHash = hash(specification), filenames = new Set(['manifest.json', ...foldIds.map(id => `${hash(id)}.json`)]);
  const inspect = () => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pending = /^\.publish-[0-9a-f-]{36}\.tmp$/.test(entry.name);
      requireThat(entry.isFile() && !entry.isSymbolicLink() && (filenames.has(entry.name) || pending),
        'STUDY_CACHE_CORRUPT', 'Cache contains unexpected files or non-file entries');
    }
  };
  inspect();
  const load = expected => {
    inspect();
    const path = join(directory, `${hash(expected.id)}.json`);
    if (!existsSync(path)) return null;
    const record = read(path);
    requireThat(record.format === 'completed-validation-fold-v1' && record.identityHash === identityHash && record.foldHash === hash(expected) && typeof record.value === 'string',
      'STUDY_CACHE_CORRUPT', 'Completed cache fold does not match its admitted fold identity');
    let value;
    try { value = deserialize(Buffer.from(record.value, 'base64')); }
    catch (error) { throw Object.assign(new Error('Completed fold payload cannot be decoded', { cause: error }), { code: 'STUDY_CACHE_CORRUPT' }); }
    requireThat(value?.fold && value.fold.id === expected.id && value.fold.foldHash === expected.foldHash && value.fold.trainingHash === expected.trainingHash && value.fold.evaluationHash === expected.evaluationHash
      && value.fold.startTime === expected.startTime && value.fold.endTime === expected.endTime && value.fold.candidate?.report && value.fold.baselines && value.route && Array.isArray(value.baselineNames),
    'STUDY_CACHE_CORRUPT', 'Completed fold payload has invalid identity or structure');
    verifyAudits(value);
    return freeze(value);
  };
  return {
    load,
    save(expected, value) {
      if (readOnly) return;
      inspect(); verifyAudits(value);
      const body = { format: 'completed-validation-fold-v1', identityHash, foldHash: hash(expected), value: serialize(value).toString('base64') };
      publish(join(directory, `${hash(expected.id)}.json`), body);
      requireThat(hash(load(expected)) === hash(value), 'STUDY_CACHE_COLLISION', 'A completed fold already has a different immutable result');
    },
  };
}

export function openStudyCache({ directory, previousDirectories = [] }, identity, foldIds) {
  requireThat(Array.isArray(previousDirectories) && previousDirectories.every(path => typeof path === 'string' && path.length > 0), 'STUDY_CACHE_INPUT', 'previousDirectories must contain explicit prior cache paths');
  const current = openCacheDirectory(directory, identity, foldIds, false);
  const previous = [...new Set(previousDirectories.map(path => resolve(path)))].filter(path => path !== resolve(directory)).map(path => openCacheDirectory(path, identity, foldIds, true));
  return {
    load(expected) {
      let completed = current.load(expected);
      for (const cache of previous) {
        const other = cache.load(expected);
        requireThat(!completed || !other || hash(completed) === hash(other), 'STUDY_CACHE_COLLISION', 'Prior completed folds disagree on their immutable result');
        completed ??= other;
      }
      return completed;
    },
    save: current.save,
  };
}
