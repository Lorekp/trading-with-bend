import { performance } from 'node:perf_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { prepareQuoteData, enqueueExperiment, runQueue, readExperimentResult } from '../src/index.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at+1]; };
const root = resolve(option('--output', 'output/scaling-campaign'));
const count = Number(option('--ticks', '2000000')), workers = Number(option('--workers', '5'));
const eventSpacingMs = Number(option('--event-spacing-ms', '1')), orderEvery = Number(option('--order-every', '288'));
if (!Number.isSafeInteger(count) || count < 2 || !Number.isSafeInteger(workers) || workers < 1 || workers > 32) throw new Error('Require ticks >=2 and workers in 1..32');
if (!Number.isSafeInteger(eventSpacingMs) || eventSpacingMs < 1 || !Number.isSafeInteger(orderEvery) || orderEvery < 1) throw new Error('Require positive event spacing and order interval');
mkdirSync(root, {recursive:true});
const start = performance.now();
let manifestPath = option('--dataset', undefined);
if (!manifestPath) {
  const instrument = {symbol:'BENCH',currency:'USDT',lotSize:'0.001',priceTick:'1'};
  const dataset = await prepareQuoteData((function* () { for (let i=0;i<count;i++) yield {
    id:`tick-${i}`,type:'tick',sequence:String(i+1),time:String(i*eventSpacingMs),sourceTime:String(i*eventSpacingMs),
    ...{symbol:instrument.symbol,currency:instrument.currency},bid:'9999',ask:'10000',bidLots:'100',askLots:'100',
  }; })(), {instrument,directory:join(root,'data')});
  manifestPath = dataset.manifest.audit.manifestPath; dataset.close();
}
manifestPath=resolve(manifestPath);
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
if (manifest.streams.quotes.count !== count) throw new Error('Dataset count differs from --ticks');
const prepared=performance.now(), registry=join(root,'registry');
for (let index=0;index<workers;index++) enqueueExperiment(registry, {
  key:`scaling/${index}`,workerModule:new URL('../experiments/scaling/worker.mjs',import.meta.url),
  configuration:{manifestPath,count,index,orderEvery,profile:args.includes('--profile') && index===0},
  dependencies:[manifestPath,join(dirname(manifestPath),manifest.file)],
});
const enqueued=performance.now();
const jobs=await runQueue(registry,{concurrency:workers,timeoutMs:3600000});
const completed=performance.now();
const results=jobs.map(job=>job.status==='completed' ? {status:job.status,...readExperimentResult(registry,job.key)} :
  {status:job.status,key:job.key,error:job.attempts.at(-1)?.error});
const summary={count,workers,eventSpacingMs:args.includes('--dataset') ? null : eventSpacingMs,orderEvery,preparedMs:prepared-start,enqueueMs:enqueued-prepared,
  campaignMs:completed-enqueued,verificationMs:performance.now()-completed,totalMs:performance.now()-start,
  datasetBytes:manifest.bytes,aggregatePeakRssUpperBoundMiB:results.reduce((n,row)=>n+(row.peakRssMiB??0),0),
  auditBytes:results.reduce((n,row)=>n+(row.auditBytes??0),0),results};
writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});
console.log(JSON.stringify(summary,null,2));
if (results.some(row=>row.status!=='completed')) process.exitCode=1;
