import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, linkSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, toNamespacedPath } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { CanonicalArrayHash, canonical, freeze, hash, immutableCopy, requireThat } from './core.mjs';

const require = createRequire(import.meta.url);
const fileHash = path => {
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try { let size; while ((size = readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
};
const decode = value => freeze(deserialize(value));
const publishManifest = (path, body) => {
  // A failed write/fsync must never leave a completed manifest discoverable.
  const temporary = `${path}.${randomUUID()}.pending`;
  writeFileSync(temporary, JSON.stringify(body, null, 2), { flag: 'wx', flush: true });
  linkSync(temporary, path); // Atomic, exclusive publication on the same filesystem.
  try { unlinkSync(temporary); } catch {} // Publication already succeeded; an orphan is harmless.
};

/** Private storage seam: the reference uses memory; large runs use indexed disk.
 * SQLite commits bounded batches. Only a sealed manifest is a complete audit;
 * crashes leave an incomplete, unpublishable attempt, never a valid result.
 */
export class ReplayRecording {
  #database; #directory; #file; #series = new Map(); #maps = new Map();
  #failed = false; #sealed = false; #pending = 0; #manifest;
  constructor(directory) {
    if (directory === undefined) return;
    requireThat(typeof directory === 'string' && directory.length > 0, 'AUDIT_PATH', 'auditDirectory must be a new directory');
    this.#directory = resolve(directory);
    mkdirSync(dirname(this.#directory), { recursive: true });
    mkdirSync(this.#directory); // Exclusive ownership: never overwrite an attempt.
    this.#file = join(this.#directory, 'audit.sqlite');
    const { DatabaseSync } = require('node:sqlite');
    this.#database = new DatabaseSync(toNamespacedPath(this.#file));
    this.#database.exec(`PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA synchronous=FULL;
      CREATE TABLE records (stream TEXT NOT NULL, ordinal INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(stream, ordinal));
      CREATE TABLE keyed (namespace TEXT NOT NULL, key TEXT NOT NULL, payload BLOB NOT NULL, UNIQUE(namespace, key));
      BEGIN`);
  }
  get disk() { return Boolean(this.#directory); }
  get sealed() { return this.#sealed; }
  assertValid() { requireThat(!this.#failed,'AUDIT_FAILED','Recording failed or was aborted'); }
  assertWritable() { requireThat(!this.#failed && !this.#sealed, 'AUDIT_CLOSED', 'Audit is failed or sealed; use a fresh replay'); }
  series(name) {
    if (this.#series.has(name)) return this.#series.get(name);
    const data = [], digest = new CanonicalArrayHash(), owner = this, db = this.#database;
    const insert = db?.prepare('INSERT INTO records VALUES (?, ?, ?)');
    const series = {
      get length() { return digest.count; },
      get hash() { return digest.digest(); },
      push(...values) { owner.assertWritable(); for (const value of values) {
        if (db) insert.run(name, digest.count, serialize(value)); else data.push(immutableCopy(value));
        digest.push(value);
      } return digest.count; },
      *[Symbol.iterator]() {
        if (!db) { yield* data; return; }
        if (owner.#sealed) { yield* readReplayAudit(owner.#manifest, name); return; }
        for (const row of db.prepare('SELECT payload FROM records WHERE stream=? ORDER BY ordinal').iterate(name)) yield decode(row.payload);
      },
      slice() { return [...this]; },
      reduce(fn, initial) { let value = initial, i = 0; for (const row of this) value = fn(value, row, i++); return value; },
    };
    this.#series.set(name, series); return series;
  }
  map(name) {
    if (this.#maps.has(name)) return this.#maps.get(name);
    const data = new Map(), db = this.#database, owner = this;
    const select = db?.prepare('SELECT payload FROM keyed WHERE namespace=? AND key=?');
    const insert = db?.prepare('INSERT INTO keyed(namespace,key,payload) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET payload=excluded.payload');
    const map = {
      get(key) { return db ? (() => { const row = select.get(name, String(key)); return row ? decode(row.payload) : undefined; })() : data.get(String(key)); },
      has(key) { return db ? Boolean(select.get(name, String(key))) : data.has(String(key)); },
      set(key,value) { owner.assertWritable(); if (db) insert.run(name,String(key),serialize(value)); else data.set(String(key),immutableCopy(value)); return this; },
      add(key) { return this.set(key,true); },
      *values() { if (!db) yield* data.values(); else {
        if (owner.#sealed) { yield* readReplayAudit(owner.#manifest, name); return; }
        for (const row of db.prepare('SELECT payload FROM keyed WHERE namespace=? ORDER BY rowid').iterate(name)) yield decode(row.payload);
      } },
    };
    this.#maps.set(name,map); return map;
  }
  transaction(work) {
    this.assertWritable();
    try {
      if (this.#database) this.#database.exec('SAVEPOINT event');
      const result = work();
      if (this.#database) {
        this.#database.exec('RELEASE event');
        if (++this.#pending >= 1024) this.flush();
      }
      return result;
    } catch (error) { this.abort(); throw error; }
  }
  flush() {
    this.assertWritable();
    if (this.#database) { this.#database.exec('COMMIT; BEGIN'); this.#pending = 0; }
  }
  contentHash(names) {
    this.assertValid();
    const digest=createHash('sha256').update('{');
    for (const [index,name] of [...names].sort().entries()) {
      if(index) digest.update(',');
      digest.update(`${JSON.stringify(name)}:[`);
      let count=0;
      const rows=this.#series.get(name) ?? this.#maps.get(name)?.values();
      requireThat(rows,'AUDIT_STREAM',`Unknown audit stream ${name}`);
      for(const row of rows) {if(count++) digest.update(',');digest.update(canonical(row));}
      digest.update(']');
    }
    return digest.update('}').digest('hex');
  }
  #describe(file, metadata, manifestName, publish = true) {
    const streams = Object.fromEntries([...this.#series].map(([name,series])=>[name,{count:series.length,hash:series.hash,kind:'series'}]));
    for (const name of this.#maps.keys()) {
      const digest = new CanonicalArrayHash();
      for (const value of this.#maps.get(name).values()) digest.push(value);
      streams[name] = {count:digest.count,hash:digest.digest(),kind:'map'};
    }
    const body = { format:'bend-replay-audit-v1', file:basename(file), bytes:statSync(file).size, sha256:fileHash(file), streams, metadata };
    const manifest = {...body,checksum:hash(body)};
    const manifestPath = join(this.#directory,manifestName);
    if (publish) publishManifest(manifestPath,manifest);
    return freeze({...manifest,manifestPath});
  }
  checkpoint(metadata) {
    requireThat(this.disk,'AUDIT_MODE','Disk checkpoint requires disk recording');
    this.flush();
    const id = randomUUID(), file = join(this.#directory,`checkpoint-${id}.sqlite`);
    copyFileSync(this.#file,file);
    return this.#describe(file,metadata,`checkpoint-${id}.json`);
  }
  seal(metadata) {
    if (this.#sealed) return this.#manifest;
    this.assertWritable();
    requireThat(this.disk,'AUDIT_MODE','Only disk recordings need publication');
    try {
      this.flush();
      this.#manifest = this.#describe(this.#file,metadata,'manifest.json',false);
      this.#database.exec('COMMIT'); this.#database.close();
      const {manifestPath,...body}=this.#manifest;
      publishManifest(manifestPath,body);
      this.#sealed = true;
      return this.#manifest;
    } catch (error) { this.abort(); throw error; }
  }
  abort() {
    if (this.#sealed || this.#failed) return;
    this.#failed = true;
    if (this.#database) { try { this.#database.exec('ROLLBACK'); } catch {} try { this.#database.close(); } catch {} }
  }
}

/** Verify complete bytes before exposing records; every call owns its cursor. */
export function openReplayAudit(input) {
  const descriptor = input?.audit ?? input;
  const manifestPath = typeof descriptor === 'string' ? resolve(descriptor) : descriptor?.manifestPath;
  requireThat(typeof manifestPath === 'string','AUDIT_MANIFEST','A completed audit manifest is required');
  const manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
  const {checksum,...body}=manifest;
  requireThat(body.format==='bend-replay-audit-v1' && checksum===hash(body) && basename(body.file)===body.file,'AUDIT_CORRUPT','Audit manifest is invalid');
  if (typeof descriptor==='object') requireThat(descriptor.checksum===checksum,'AUDIT_CORRUPT','Audit descriptor changed');
  const file=join(dirname(manifestPath),body.file);
  requireThat(statSync(file).size===body.bytes && fileHash(file)===body.sha256,'AUDIT_CORRUPT','Audit database bytes changed');
  const {DatabaseSync}=require('node:sqlite');
  const db = new DatabaseSync(toNamespacedPath(file),{readOnly:true});
  db.exec('PRAGMA cache_size=-2048; PRAGMA query_only=ON');
  return {
    manifest:freeze({...manifest,manifestPath}),
    *records(stream) {
      const spec=body.streams[stream]; requireThat(spec,'AUDIT_STREAM',`Unknown audit stream ${stream}`);
      const query=spec.kind==='series'?'SELECT payload FROM records WHERE stream=? ORDER BY ordinal':'SELECT payload FROM keyed WHERE namespace=? ORDER BY rowid';
      const digest=new CanonicalArrayHash();
      for(const row of db.prepare(query).iterate(stream)) {const value=decode(row.payload); digest.push(value); yield value;}
      requireThat(digest.count===spec.count && digest.digest()===spec.hash,'AUDIT_CORRUPT','Audit content identity differs');
    },
    has(stream,key) { return Boolean(db.prepare('SELECT 1 FROM keyed WHERE namespace=? AND key=?').get(stream,String(key))); },
    close() { db.close(); },
  };
}

export function* readReplayAudit(input, stream) {
  const audit=openReplayAudit(input);
  try { yield* audit.records(stream); } finally { audit.close(); }
}
