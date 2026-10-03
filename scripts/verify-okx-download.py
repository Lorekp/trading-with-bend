"""Verify OKX archive integrity and UTC coverage without extracting large files.

Run after, or alongside, download-okx.mjs. Every L2 record header is scanned;
every snapshot and every 10,000th payload is parsed. This is not a full replay.
"""
import concurrent.futures
import csv
import datetime
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys
import tarfile
import time
import zipfile

MONTH = sys.argv[1] if len(sys.argv) > 1 else '2026-09'
ROOT = Path(__file__).resolve().parents[1] / 'data/okx/swap/ETH-USDT-SWAP' / MONTH
MANIFEST = ROOT / 'manifest.json'
VALIDATION = ROOT / 'validation'
VALIDATION.mkdir(exist_ok=True)
HEADER = re.compile(rb'^\{"instId":"ETH-USDT-SWAP","action":"(snapshot|update)","ts":"(\d+)"')


def utc_ms(value):
    try:
        return int(value)
    except ValueError:
        return int(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).replace(tzinfo=datetime.timezone.utc).timestamp()*1000)


def validate_file(record, kind, start, end):
    path = ROOT / record['path']
    report = dict(path=record['path'], type=kind, bytes=path.stat().st_size,
                  records=0, inWindowRecords=0, firstTime=None, lastTime=None,
                  timestampRegressions=0, maxGapMs=0, sampledPayloads=0,
                  snapshots=0, headerValid=True, errors=[])
    with path.open('rb') as f:
        report['sha256'] = hashlib.file_digest(f, 'sha256').hexdigest()
    if report['sha256'] != record['sha256']:
        raise ValueError(f'Hash mismatch: {path}')
    previous = None
    minutes = set()
    candle_times = set()

    def timestamp(t):
        nonlocal previous
        report['records'] += 1
        report['firstTime'] = t if report['firstTime'] is None else min(t,report['firstTime'])
        report['lastTime'] = t if report['lastTime'] is None else max(t,report['lastTime'])
        if previous is not None:
            report['timestampRegressions'] += t < previous
            report['maxGapMs'] = max(report['maxGapMs'],t-previous)
        previous=t
        if start <= t < end:
            report['inWindowRecords'] += 1
            minutes.add(t//60000)

    if kind == 'l2Book400':
        report['verificationScope'] = 'All gzip bytes/CRC; every record header/time; every snapshot and each 10000th payload; no full replay'
        with gzip.open(path,'rb') as compressed:
            with tarfile.open(fileobj=compressed,mode='r|') as tar:
                for member in tar:
                    if not member.isfile(): continue
                    with tar.extractfile(member) as f:
                        for line in f:
                            match=HEADER.match(line[:160])
                            if not match: raise ValueError(f'Invalid L2 header at {report["records"]}: {path}')
                            action=match[1]
                            t=int(match[2]); timestamp(t)
                            if action==b'snapshot': report['snapshots']+=1
                            if action==b'snapshot' or report['records']%10000==0:
                                row=json.loads(line)
                                assert row['instId']=='ETH-USDT-SWAP'
                                assert row['action'] in ('snapshot','update')
                                for key in ('bids','asks'):
                                    levels=row[key]
                                    if action==b'snapshot': assert len(levels)==400
                                    for p,q,*extra in levels:
                                        assert math.isfinite(float(p)) and float(p)>0
                                        assert math.isfinite(float(q)) and float(q)>=0
                                if action==b'snapshot': assert float(row['bids'][0][0])<float(row['asks'][0][0])
                                report['sampledPayloads']+=1
            # tar EOF may precede the gzip trailer. Drain to force CRC verification.
            while compressed.read(8*1024*1024): pass
        if not report['snapshots']: report['errors'].append('No snapshot')
        if report['timestampRegressions']: report['errors'].append('L2 time regression')
    else:
        report['verificationScope']='All ZIP member bytes/CRC and CSV rows; timestamp coverage; candle OHLC validation'
        with zipfile.ZipFile(path) as z:
            for member in z.infolist():
                if member.is_dir(): continue
                with z.open(member) as f:
                    reader=csv.DictReader(io.TextIOWrapper(f,encoding='utf-8-sig',newline=''))
                    columns=reader.fieldnames
                    report['columns']=columns
                    time_key=next((k for k in ('open_time','created_time','timestamp','ts','time') if k in columns),None)
                    if time_key is None: raise ValueError(f'Unknown CSV timestamp: {columns}')
                    for row in reader:
                        t=utc_ms(row[time_key]); timestamp(t)
                        instrument=row.get('instrument_name',row.get('instId'))
                        if instrument is not None and instrument!='ETH-USDT-SWAP': raise ValueError('Wrong instrument')
                        if kind=='candles1m':
                            o,h,l,c=map(float,(row[k] for k in ('open','high','low','close')))
                            assert all(map(math.isfinite,(o,h,l,c))) and 0<l<=min(o,c)<=max(o,c)<=h
                            assert row['confirm']=='1' and t%60000==0
                            if start<=t<end:
                                if t in candle_times: report['errors'].append(f'Duplicate candle {t}')
                                candle_times.add(t)
    report['minuteBuckets']=sorted(minutes)
    report['candleTimes']=sorted(candle_times)
    report['archiveIntegrity']='CRC and local SHA-256 verified; no vendor SHA-256 provided'
    report['status']='verified' if not report['errors'] else 'invalid'
    report['verifiedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    out=VALIDATION/(path.name+'.json')
    out.write_text(json.dumps(report,indent=2)+'\n')
    print(f'Verified {path.name}: {report["records"]:,} records',flush=True)
    return report


def finalize(m, results):
    start,end=m['window']['startTime'],m['window']['endTimeExclusive']
    expected=set(range(start//60000,end//60000))
    for d in m['datasets']:
        if d['type'] in ('l2Book400','trades','candles1m'):
            minutes=set();count=0;times=set();duplicates=0
            for f in d['files']:
                report=results[f['path']]
                f['status']=report['status']; f['validation']=str((Path('validation')/(Path(f['path']).name+'.json')).as_posix())
                f['records']=report['records'];f['firstTime']=report['firstTime'];f['lastTime']=report['lastTime']
                minutes.update(report['minuteBuckets']);count+=report['inWindowRecords']
                for t in report['candleTimes']:
                    duplicates+=t in times;times.add(t)
            d['coverage']={'basis':'UTC minute buckets with observations, not proof of every exchange event',
                           'expectedMinutes':len(expected),'observedMinutes':len(minutes),
                           'missingMinutes':sorted(expected-minutes),'inWindowRecords':count}
            if d['type']=='candles1m':d['coverage']['duplicateCandles']=duplicates
            d['status']='complete' if len(d['files'])==d['expectedFiles'] and all(f['status']=='verified' for f in d['files']) and minutes==expected and duplicates==0 else 'incomplete'
        elif d['type'] in ('markPrice1m','indexPrice1m','premiumHistory','fundingRate'):
            if not d['files']: continue
            rows=json.loads((ROOT/d['files'][0]['path']).read_text())
            premium=d['type']=='premiumHistory';funding=d['type']=='fundingRate'
            get_time=lambda row:int(row['ts'] if premium else row['fundingTime'] if funding else row[0])
            stamps=[get_time(r) for r in rows]
            assert stamps==sorted(set(stamps)) and all(start<=t<end for t in stamps)
            for row in rows:
                if not premium and not funding:
                    o,h,l,c=map(float,row[1:5]);assert all(map(math.isfinite,(o,h,l,c))) and 0<l<=min(o,c)<=max(o,c)<=h
                    assert row[-1]=='1'
                else:
                    assert row['instId']=='ETH-USDT-SWAP'
                    assert math.isfinite(float(row['premium'] if premium else row['fundingRate']))
            step=8*3600000 if funding else 60000
            actual={t//step for t in stamps};wanted=set(range(start//step,end//step))
            d['coverage']={'basis':'UTC minute buckets; native observation timestamps preserved' if premium else 'Exact interval timestamps',
                           'expectedRows':len(wanted),'observedBuckets':len(actual),'missingBuckets':sorted(wanted-actual)}
            d['missingRanges']=[{'start':b*step,'endExclusive':(b+1)*step} for b in sorted(wanted-actual)]
            d['status']='complete' if actual==wanted and (premium or all(t%step==0 for t in stamps)) else 'partial'
            gap_check=ROOT/'api/premium-gap-check.json'
            if premium and gap_check.exists():
                checks=json.loads(gap_check.read_text())
                checked={entry['gap']['start']//step for entry in checks}
                if checked==wanted-actual and all(entry['response']['code']=='0' for entry in checks):
                    recovered=sum(entry['gap']['start']<=int(row['ts'])<entry['gap']['endExclusive']
                                  for entry in checks
                                  for row in entry['response']['data'])
                    d['sourceGapCheck']={'path':'api/premium-gap-check.json',
                                         'sha256':hashlib.sha256(gap_check.read_bytes()).hexdigest(),
                                         'checkedMinutes':len(checked),'recoveredRows':recovered}
            for f in d['files']:
                assert hashlib.sha256((ROOT/f['path']).read_bytes()).hexdigest()==f['sha256']
                f['status']='verified'
    m['complete']=all(d['status'] in ('complete','reference-only') for d in m['datasets'])
    m['verifiedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    m['verificationScope']='Archive CRC/SHA-256, all record timestamps, all CSV rows; L2 payloads sampled, not full-month book replay'
    temporary=MANIFEST.with_suffix('.json.tmp');temporary.write_text(json.dumps(m,indent=2)+'\n');temporary.replace(MANIFEST)
    print('FINAL',json.dumps({'complete':m['complete'],'datasets':[{k:d.get(k) for k in ('type','status','rows','coverage')}for d in m['datasets']]}),flush=True)


def main():
    results={};running={};submitted=set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        while True:
            m=json.loads(MANIFEST.read_text())
            for d in m['datasets']:
                if d['type'] not in ('l2Book400','trades','candles1m'):continue
                for f in d['files']:
                    if f['path'] in submitted or f['status'] not in ('downloaded','verified'):continue
                    submitted.add(f['path'])
                    cached=VALIDATION/(Path(f['path']).name+'.json')
                    if cached.exists():
                        report=json.loads(cached.read_text())
                        if report['sha256']==f['sha256']:
                            archive = ROOT / f['path']
                            with archive.open('rb') as current:
                                digest = hashlib.file_digest(current, 'sha256').hexdigest()
                            if archive.stat().st_size != f['bytes'] or digest != f['sha256']:
                                raise ValueError(f'Hash/size mismatch: {archive}')
                            results[f['path']]=report;continue
                    running[pool.submit(validate_file,f,d['type'],m['window']['startTime'],m['window']['endTimeExclusive'])]=f['path']
            for future in list(running):
                if future.done():
                    key=running.pop(future)
                    results[key]=future.result()
            if m.get('downloadFinishedAt') and not running:
                wanted=[f['path']for d in m['datasets']if d['type'] in ('l2Book400','trades','candles1m') for f in d['files']]
                if all(p in results for p in wanted):finalize(m,results);return
                raise RuntimeError('Downloader ended with missing files; inspect manifest')
            time.sleep(2)


if __name__=='__main__':main()
