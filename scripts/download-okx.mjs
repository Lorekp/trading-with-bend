// Public OKX ETH perpetual acquisition. Does not select or modify any adapter.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hashFile } from '../src/archive.mjs';
import { monthWindow } from './download-hyperliquid.mjs';

const month = process.argv[2] ?? '2026-09';
const { startTime: start, endTimeExclusive: end } = monthWindow(month);
if (end > Date.now()) throw new Error('Use a completed month');
const root = resolve('data/okx/swap/ETH-USDT-SWAP', month);
mkdirSync(join(root, 'catalog'), { recursive: true });
const path = join(root, 'manifest.json');
const manifest = existsSync(path) ? JSON.parse(readFileSync(path)) : {
  schema: 'okx-download-v1', symbol: 'ETH-USDT-SWAP', month,
  window: { startTime: start, endTimeExclusive: end }, startedAt: new Date().toISOString(),
  primaryInformationSource: 'binance', selectedExecutionVenueChanged: false,
  purpose: 'Local alternative dataset; no strategy or execution configuration changed',
  datasets: [], complete: false,
  limitations: [
    'Scope is ETH-USDT perpetual for the matching Binance month, not all OKX instruments/history.',
    'L2 contains 400 levels per side, not unlimited depth or individual orders.',
    'Local SHA-256 records HTTPS response integrity; no vendor SHA-256 is supplied.',
    'Trade/candle archives use UTC+8 calendar boundaries; adjacent files are included and consumers must filter UTC timestamps.',
    'Instrument and position-tier metadata are current references, not historical rule schedules.',
    'This acquisition does not implement perpetual margin, funding accounting or maker queue realism.'
  ]
};
const save = () => { writeFileSync(path + '.tmp', JSON.stringify(manifest, null, 2)); renameSync(path + '.tmp', path); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let requestQueue = Promise.resolve();
async function request(url, body, delay = 260) {
  const previous = requestQueue;
  let release;
  requestQueue = new Promise(r => { release = r; });
  await previous;
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(attempt ? 1500 * attempt : delay);
      try {
        const response = await fetch(url, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
        const text = await response.text();
        const json = JSON.parse(text);
        if (response.status === 429 || json.code === '50011') continue;
        if (!response.ok || json.code !== '0') throw new Error(`${response.status} ${text.slice(0,300)}`);
        return { text, json, retrievedAt: new Date().toISOString(), url, request: body };
      } catch (error) { if (attempt === 5) throw error; }
    }
    throw new Error(`Rate limit retries exhausted: ${url}`);
  } finally { release(); }
}
function dataset(type) {
  let value = manifest.datasets.find(d => d.type === type);
  if (!value) { value = { type, status: 'pending', files: [] }; manifest.datasets.push(value); }
  return value;
}
function artifact(relative, value) {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value);
  const destination = join(root, relative);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  writeFileSync(destination, bytes);
  return { path: relative.replaceAll('\\','/'), bytes: Buffer.byteLength(bytes), sha256: sha(bytes) };
}
async function catalog() {
  for (const [module, type] of [['4','l2Book400'], ['1','trades'], ['2','candles1m']]) {
    const d = dataset(type); d.status = 'cataloging'; save();
    const days = (end-start)/86400000 + (module === '4' ? 0 : 1);
    for (let first = 0; first < days; first += 7) {
      const last = Math.min(days-1, first+6);
      const offset = module === '4' ? 86400000-1 : -1;
      const body = { module, instType: 'SWAP', instQueryParam: { instFamilyList: ['ETH-USDT'] },
        dateQuery: { dateAggrType: 'daily', begin: String(start+first*86400000+offset), end: String(start+last*86400000+offset) } };
      const filename = `catalog/${type}-${first}-${last}.json`;
      let json;
      if (existsSync(join(root,filename))) json = JSON.parse(readFileSync(join(root,filename)));
      else { const result = await request('https://www.okx.com/priapi/v5/broker/public/trade-data/download-link',body,1500); json=result.json; artifact(filename,result.text); }
      if (json.code !== '0') throw new Error(`Invalid catalog ${filename}`);
      for (const file of json.data.details.flatMap(x => x.groupDetails)) {
        if (basename(file.filename) !== file.filename || !file.filename.startsWith('ETH-USDT-SWAP-')) throw new Error('Unexpected archive name');
        if (new URL(file.url).hostname !== 'static.okx.com') throw new Error('Unexpected archive host');
        if (!d.files.some(x => x.filename === file.filename)) d.files.push({ ...file, path: `${type}/${file.filename}`, status: 'pending' });
      }
      save();
    }
    d.files.sort((a,b) => a.filename.localeCompare(b.filename));
    d.expectedFiles = days;
    d.status = d.files.length === days ? 'catalog-complete' : 'catalog-incomplete';
    console.log(`${type}: ${d.files.length}/${days} files, ${(d.files.reduce((n,f)=>n+Number(f.sizeMB),0)/1024).toFixed(2)} GiB advertised`); save();
  }
}
async function download(file) {
  const destination = join(root,file.path);
  mkdirSync(resolve(destination,'..'), { recursive: true });
  if (existsSync(destination) && file.sha256) {
    if (await hashFile(destination) !== file.sha256) throw new Error(`Archive hash mismatch: ${file.filename}; preserve the file for investigation`);
    return;
  }
  let reusedSample = false;
  const sample = resolve('data/execution-venue-comparison',file.filename);
  if (!existsSync(destination) && existsSync(sample)) {
    const auditPath = resolve('data/execution-venue-comparison/okx-audit.json');
    const audit = JSON.parse(readFileSync(auditPath));
    if (audit.archive === file.filename && await hashFile(sample) === audit.sha256) {
      copyFileSync(sample,destination); reusedSample = true; file.reusedSample = true;
    }
  }
  if (!reusedSample) {
    for (let attempt=0; attempt<5; attempt++) {
      try {
        const partial=destination+'.part';
        const offset=existsSync(partial)?statSync(partial).size:0;
        const response = await fetch(file.url,{headers:offset?{Range:`bytes=${offset}-`}:{},signal:AbortSignal.timeout(1800000)});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??'');
        const append=response.status===206;
        if(append&&(!range||Number(range[1])!==offset))throw new Error('Invalid resume range');
        const expected = append?Number(range[3]):Number(response.headers.get('content-length'));
        if (!Number.isSafeInteger(expected) || expected<=0) throw new Error('Missing content length');
        const free=statfsSync(root,{bigint:true});
        if (free.bavail*free.bsize < BigInt(expected)+5n*1024n**3n) throw new Error('Less than 5 GiB free headroom');
        file.status='downloading'; save();
        console.log(`Downloading ${file.filename} ${(expected/1e6).toFixed(1)} MB${append?` (resume at ${(offset/1e6).toFixed(1)} MB)`:''}`);
        await pipeline(Readable.fromWeb(response.body),createWriteStream(partial,{flags:append?'a':'w'}));
        if (statSync(destination+'.part').size!==expected) throw new Error('Content length mismatch');
        renameSync(destination+'.part',destination);
        file.httpContentLength=expected; break;
      } catch(error) { if(attempt===4)throw error; await sleep(1000*(attempt+1)); }
    }
  }
  file.bytes=statSync(destination).size; file.sha256=await hashFile(destination);
  file.status='downloaded'; file.downloadedAt=new Date().toISOString(); save();
  console.log(`Downloaded ${file.filename}`);
}
async function archives() {
  await catalog();
  const jobs=manifest.datasets.filter(d=>['l2Book400','trades','candles1m'].includes(d.type)).flatMap(d=>d.files);
  let cursor=0;
  await Promise.all(Array.from({length:6},async()=>{
    while(cursor<jobs.length){const file=jobs[cursor++];try{await download(file);}catch(e){file.status='failed';file.error=e.message;save();console.error(file.filename,e.message);}}
  }));
  for(const d of manifest.datasets.filter(d=>['l2Book400','trades','candles1m'].includes(d.type))){
    d.status=d.files.length===d.expectedFiles && d.files.every(f=>['downloaded','verified'].includes(f.status))?'downloaded':'incomplete';
  }
  save();
}
async function series(type, endpoint, params, timeOf, stepMs) {
  const d=dataset(type);
  if(d.status==='complete')return;
  d.status='in-progress';save();
  let after=end, page=0;const rows=new Map();
  for(;;){
    const url=new URL(`https://www.okx.com${endpoint}`);
    for(const [k,v] of Object.entries({...params,after:String(after),limit:'100'}))url.searchParams.set(k,v);
    const name=`api/${type}/page-${String(page).padStart(4,'0')}.json`;
    let data;
    if(existsSync(join(root,name))){data=JSON.parse(readFileSync(join(root,name))).data;}
    else{const result=await request(url.toString());artifact(name,result.text);data=result.json.data;}
    if(!Array.isArray(data))throw new Error(`Invalid ${type} response`);
    if(!data.length)break;
    let earliest=after;
    for(const row of data){const t=Number(timeOf(row));if(!Number.isSafeInteger(t))throw new Error('Invalid timestamp');earliest=Math.min(earliest,t);if(t>=start&&t<end)rows.set(t,row);}
    if(earliest>=after)throw new Error(`${type}: pagination stalled`);
    page++;if(page%100===0)console.log(`${type}: ${rows.size} rows`);
    if(earliest<=start)break;after=earliest;
  }
  const ordered=[...rows.entries()].sort((a,b)=>a[0]-b[0]);
  d.files=[artifact(`${type}.json`,ordered.map(x=>x[1]))];
  d.rows=ordered.length;d.firstTime=ordered[0]?.[0]??null;d.lastTime=ordered.at(-1)?.[0]??null;
  d.endpoint=endpoint;d.params=params;d.pages=page;d.expectedStepMs=stepMs;
  d.missingRanges=[];
  if(stepMs){
    // Premium observations occur within a minute rather than on its opening boundary.
    const times=[...new Set(ordered.map(([t])=>type==='premiumHistory'?Math.floor(t/stepMs)*stepMs:t))];
    d.coverageBasis=type==='premiumHistory'?'UTC minute buckets; native observation timestamps preserved':'exact timestamps';
    let next=start;for(const t of times){if(t>next)d.missingRanges.push({start:next,endExclusive:t});next=t+stepMs;}if(next<end)d.missingRanges.push({start:next,endExclusive:end});
  }
  d.status=ordered.length && (!stepMs||!d.missingRanges.length)?'complete':'partial';save();
  console.log(`${type}: ${d.rows} rows, ${d.status}`);
}
async function references(){
  const specs=[
    ['fundingRate','/api/v5/public/funding-rate-history',{instId:'ETH-USDT-SWAP'},r=>r.fundingTime,8*3600000],
    ['markPrice1m','/api/v5/market/history-mark-price-candles',{instId:'ETH-USDT-SWAP',bar:'1m'},r=>r[0],60000],
    ['indexPrice1m','/api/v5/market/history-index-candles',{instId:'ETH-USDT',bar:'1m'},r=>r[0],60000],
    ['premiumHistory','/api/v5/public/premium-history',{instId:'ETH-USDT-SWAP'},r=>r.ts,60000]
  ];
  await Promise.all(specs.map(async args=>{try{await series(...args);}catch(e){const d=dataset(args[0]);d.status='failed';d.error=e.message;save();console.error(args[0],e.message);}}));
  for(const [type,endpoint]of [
    ['instrumentReference','/api/v5/public/instruments?instType=SWAP&instId=ETH-USDT-SWAP'],
    ['positionTiersReference','/api/v5/public/position-tiers?instType=SWAP&tdMode=cross&instFamily=ETH-USDT']
  ]){const d=dataset(type);try{const r=await request(`https://www.okx.com${endpoint}`);d.files=[artifact(`${type}.json`,r.text)];d.status='reference-only';d.retrievedAt=r.retrievedAt;}catch(e){d.status='failed';d.error=e.message;}save();}
}
// A resumed run must not expose an earlier completion marker to the verifier.
manifest.complete=false;
delete manifest.downloadFinishedAt;
delete manifest.downloadComplete;
delete manifest.verifiedAt;
save();
await Promise.all([archives(),references()]);
manifest.downloadFinishedAt=new Date().toISOString();
manifest.downloadComplete=manifest.datasets.every(d=>['downloaded','complete','reference-only'].includes(d.status));
// A separate offline archive validator must establish file integrity/coverage.
manifest.complete=false;save();
console.log(`Download complete=${manifest.downloadComplete}; pending offline validation: ${path}`);
if(!manifest.downloadComplete)process.exitCode=2;
