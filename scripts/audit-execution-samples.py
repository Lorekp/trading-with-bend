"""Offline audit of the downloaded 2026-09-15 ETH perpetual L2 samples.

Uses only Python's standard library. Statistics are descriptive, not fill proofs.
Run: python scripts/audit-execution-samples.py bybit|okx
"""
import collections
import csv
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1] / 'data/execution-venue-comparison'
START = 1789430400000
END = START + 86400000


def price_ticks(value):
    whole, _, fraction = value.partition('.')
    if len(fraction) > 2 and any(c != '0' for c in fraction[2:]):
        raise ValueError(f'Price not on cent grid: {value}')
    return int(whole) * 100 + int((fraction + '00')[:2])


def distribution(values):
    if not values:
        return None
    values = sorted(values)
    return dict(count=len(values), min=values[0], median=values[len(values)//2],
                p95=values[min(len(values)-1, math.ceil(len(values)*.95)-1)],
                p99=values[min(len(values)-1, math.ceil(len(values)*.99)-1)],
                max=values[-1], mean=sum(values)/len(values))


def histogram_distribution(hist):
    total = sum(hist.values())
    result = {'count': total}
    for label, q in [('median', .5), ('p95', .95), ('p99', .99)]:
        cumulative = 0
        for value, count in sorted(hist.items()):
            cumulative += count
            if cumulative >= math.ceil(total*q):
                result[label] = value
                break
    result.update(min=min(hist), max=max(hist), mean=sum(k*v for k,v in hist.items())/total)
    return result


def audit(venue):
    filename = ('2026-09-15_ETHUSDT_ob200.data.zip' if venue == 'bybit' else
                'ETH-USDT-SWAP-L2orderbook-400lv-2026-09-15.tar.gz')
    path = ROOT / filename
    if venue == 'okx':
        instrument = json.loads((ROOT/'okx-instrument.json').read_text())['data'][0]
        multiplier = float(instrument['ctVal']) * float(instrument['ctMult'])
        assert instrument['ctValCcy'] == 'ETH'
    else:
        multiplier = 1
    stats = dict(venue=venue, archive=filename, compressedBytes=path.stat().st_size,
                 requestedStartMs=START, requestedEndExclusiveMs=END,
                 quantityToETH=multiplier, quantityMetadataIsCurrent=True,
                 records=0, snapshots=0, updates=0, malformed=0,
                 timestampRegressions=0, equalTimestamps=0, outsideDay=0,
                 crossedBooks=0, lockedBooks=0, emptyBooks=0, invalidLevels=0,
                 duplicatePricesInMessage=0, wrongSymbol=0, updatesBeforeSnapshot=0,
                 sequenceRegressions=0, equalUpdateIds=0, nonUnitUpdateIdSteps=0,
                 sequenceFieldsPresent=0, checksumFieldsPresent=0,
                 minBidLevels=10**9, maxBidLevels=0, minAskLevels=10**9, maxAskLevels=0)
    with path.open('rb') as f:
        stats['sha256'] = hashlib.file_digest(f, 'sha256').hexdigest()
    bids, asks = {}, {}
    best_bid = best_ask = None
    last_ts = last_uid = last_seq = None
    have_snapshot = False
    gaps = collections.Counter()
    worst_gaps = []
    latencies = []
    metrics = collections.defaultdict(list)
    next_grid = START + 2000  # Same UTC grid for both venues, after Bybit's first snapshot.
    output = gzip.open(ROOT/f'{venue}-bookTicker-1s.csv.gz', 'wt', newline='')
    writer = csv.writer(output)
    writer.writerow(['asOfMs','sourceTsMs','bidPrice','bidSizeETH','askPrice','askSizeETH'])

    def sample(at):
        if not bids or not asks or best_bid >= best_ask:
            return
        bp, ap = best_bid/100, best_ask/100
        mid = (bp+ap)/2
        metrics['quoteAgeMs'].append(at-last_ts)
        metrics['spreadBps'].append((ap-bp)/mid*10000)
        metrics['bestBidNotionalUSDT'].append(bp*bids[best_bid]*multiplier)
        metrics['bestAskNotionalUSDT'].append(ap*asks[best_ask]*multiplier)
        writer.writerow([at,last_ts,bp,bids[best_bid]*multiplier,ap,asks[best_ask]*multiplier])
        for name, book, reverse in [('bid', bids, True), ('ask', asks, False)]:
            levels = sorted(book, reverse=reverse)
            for band in (1,5,10):
                lower, upper = mid*(1-band/10000), mid*(1+band/10000)
                depth = sum(p/100*book[p]*multiplier for p in levels if lower <= p/100 <= upper)
                metrics[f'{name}Depth{band}bpsUSDT'].append(depth)
            for notional in (10000,100000):
                target = notional/mid
                remaining, value = target, 0
                for p in levels:
                    take = min(remaining,book[p]*multiplier)
                    value += take*p/100
                    remaining -= take
                    if remaining <= 1e-10:
                        break
                if remaining > 1e-10:
                    metrics[f'{name}Insufficient{notional}USDT'].append(1)
                else:
                    avg = value/target
                    cost = (mid-avg if reverse else avg-mid)/mid*10000
                    metrics[f'{name}Sweep{notional}USDTBps'].append(cost)

    def rows():
        if venue == 'bybit':
            with zipfile.ZipFile(path) as z:
                stats['uncompressedBytes'] = sum(i.file_size for i in z.infolist())
                for name in z.namelist():
                    with z.open(name) as f:
                        yield from f  # Reading through EOF verifies ZIP CRC.
        else:
            stats['uncompressedBytes'] = 0
            with tarfile.open(path, 'r|gz') as tar:
                for member in tar:
                    if member.isfile():
                        stats['uncompressedBytes'] += member.size
                        with tar.extractfile(member) as f:
                            yield from f

    for line in rows():
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            stats['malformed'] += 1
            continue
        if venue == 'bybit':
            ts = int(row['ts']); data = row['data']; action = row['type']
            bb, aa = data['b'], data['a']
            if data['s'] != 'ETHUSDT': stats['wrongSymbol'] += 1
            uid, seq = data.get('u'), data.get('seq')
            if 'cts' in row: latencies.append(ts-int(row['cts']))
        else:
            ts = int(row['ts']); data = row; action = row['action']
            bb, aa = row['bids'], row['asks']
            if row['instId'] != 'ETH-USDT-SWAP': stats['wrongSymbol'] += 1
            uid, seq = row.get('seqId'), None
        stats['records'] += 1
        if stats['records'] % 500000 == 0:
            print(venue, stats['records'], ts, flush=True)
        if last_ts is None: stats['firstTimestampMs'] = ts
        else:
            gap = ts-last_ts
            gaps[gap] += 1
            if gap < 0: stats['timestampRegressions'] += 1
            if gap == 0: stats['equalTimestamps'] += 1
            if gap > 1000: worst_gaps.append((gap,last_ts,ts))
            while next_grid < ts and next_grid < END:
                sample(next_grid)
                next_grid += 1000
        if not START <= ts < END: stats['outsideDay'] += 1
        if action == 'snapshot':
            stats['snapshots'] += 1
            bids.clear(); asks.clear(); best_bid = best_ask = None
            have_snapshot = True
        else:
            stats['updates'] += 1
            if not have_snapshot: stats['updatesBeforeSnapshot'] += 1
            if uid is not None and last_uid is not None:
                stats['sequenceRegressions'] += uid < last_uid
                stats['equalUpdateIds'] += uid == last_uid
                stats['nonUnitUpdateIdSteps'] += uid != last_uid+1
            if seq is not None and last_seq is not None and seq < last_seq:
                stats['sequenceRegressions'] += 1
        stats['sequenceFieldsPresent'] += uid is not None
        stats['checksumFieldsPresent'] += 'checksum' in data
        for levels, book, is_bid in [(bb,bids,True),(aa,asks,False)]:
            seen = set()
            for level in levels:
                p, size = price_ticks(level[0]), float(level[1])
                if p in seen: stats['duplicatePricesInMessage'] += 1
                seen.add(p)
                if p <= 0 or not math.isfinite(size) or size < 0:
                    stats['invalidLevels'] += 1
                    continue
                if size == 0:
                    book.pop(p, None)
                else:
                    book[p] = size
                    if is_bid and (best_bid is None or p > best_bid): best_bid = p
                    if not is_bid and (best_ask is None or p < best_ask): best_ask = p
            if is_bid and best_bid not in book: best_bid = max(book,default=None)
            if not is_bid and best_ask not in book: best_ask = min(book,default=None)
        stats['minBidLevels'] = min(stats['minBidLevels'],len(bids))
        stats['maxBidLevels'] = max(stats['maxBidLevels'],len(bids))
        stats['minAskLevels'] = min(stats['minAskLevels'],len(asks))
        stats['maxAskLevels'] = max(stats['maxAskLevels'],len(asks))
        if not bids or not asks: stats['emptyBooks'] += 1
        else:
            stats['crossedBooks'] += best_bid > best_ask
            stats['lockedBooks'] += best_bid == best_ask
        last_ts, last_uid, last_seq = ts,uid,seq
    while next_grid < END:
        sample(next_grid); next_grid += 1000
    output.close()
    stats.update(lastTimestampMs=last_ts, startBoundaryMissingMs=stats['firstTimestampMs']-START,
                 endBoundaryMs=END-last_ts, interMessageMs=histogram_distribution(gaps),
                 gapsOver1s=len(worst_gaps), largestGaps=sorted(worst_gaps,reverse=True)[:20],
                 matchingEngineToPublisherMs=distribution(latencies),
                 sampleGrid='1 second UTC as-of grid, 00:00:02 through 23:59:59 inclusive',
                 metrics={k:distribution(v) for k,v in metrics.items()})
    stats['limitations'] = [
        'One day only; not evidence of full-month completeness.',
        'No local receipt timestamps: transport latency and availability time are unknown.',
        'Sweeps assume displayed liquidity is accessible; no latency, impact or queue model.',
        'OKX contract multiplier is current metadata, not a historical specification archive.',
        'Bybit update ID jumps are reported, not assumed missing messages; cross sequence is market-wide.',
        'Book quantities and descriptive metrics use floating-point arithmetic; not formally proved.'
    ]
    (ROOT/f'{venue}-audit.json').write_text(json.dumps(stats,indent=2)+'\n')
    print(json.dumps({k:v for k,v in stats.items() if k!='metrics'},indent=2),flush=True)


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in ('bybit','okx'):
        raise SystemExit('Usage: python scripts/audit-execution-samples.py bybit|okx')
    audit(sys.argv[1])
