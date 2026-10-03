import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hash, nat, checked, requireThat, freeze } from './core.mjs';
import { exactDecimal, scaledDecimal, rationalStrings } from './decimal.mjs';
import { marketArchiveLines, verifyMarketFile, unchangedFile } from './market-archives.mjs';
import { loadBinanceBars, loadBinanceSeries } from './binance-bars.mjs';
import { validQuote } from './policies.mjs';

const MINUTE = 60000n;
const TYPES = { bars: 'candles1m', bookTicker: 'l2Book400', trades: 'trades', markPrice: 'markPrice1m', indexPrice: 'indexPrice1m', premium: 'premiumHistory', funding: 'fundingRate' };
const BINANCE = { bars: 'klines', markPrice: 'markPriceKlines', indexPrice: 'indexPriceKlines', premium: 'premiumIndexKlines', funding: 'fundingRate' };
const strings = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
const price = value => {
  const result = scaledDecimal(value, 1000n, 'price');
  requireThat(result > 0n && result % 10n === 0n, 'PRICE_TICK', 'ETH trade price must be a positive cent tick');
  return result;
};
function bar(values, time) {
  const [open, high, low, close] = values.map(price);
  requireThat(low <= open && low <= close && high >= open && high >= close && low <= high, 'BAR_OHLC', 'Invalid OHLC bounds');
  requireThat(time % MINUTE === 0n, 'BAR_INTERVAL', 'One-minute bars must be UTC aligned');
  return { openTime: time, closeTime: time + MINUTE - 1n, availableAt: checked(time + MINUTE, 'bar availability'), open, high, low, close };
}

/** Open a data-only adapter. All exchange-specific schemas stay behind this seam. */
export async function openMarketSource({ venue, kind, manifestPath, startTime, endTime, publicationDelayMs = '0', contractSizeETH } = {}) {
  requireThat(['binance', 'okx'].includes(venue) && Object.hasOwn(TYPES, kind), 'DATA_SOURCE', 'Select a supported venue and dataset kind');
  const text = await readFile(manifestPath, 'utf8'), raw = JSON.parse(text), directory = dirname(resolve(manifestPath));
  const start = nat(startTime, 'startTime'), end = nat(endTime, 'endTime'), delay = nat(publicationDelayMs, 'publicationDelayMs');
  requireThat(start < end, 'DATA_RANGE', 'Require a nonempty UTC selection');
  const nativeType = venue === 'okx' ? TYPES[kind] : BINANCE[kind];
  requireThat(nativeType, 'DATA_SOURCE', 'This Binance adapter supports the existing small-data series; no synthetic book is inferred');
  requireThat(venue === 'okx' ? raw.schema === 'okx-download-v1' && raw.symbol === 'ETH-USDT-SWAP' : raw.symbol === 'ETHUSDT' && raw.market === 'USD-M perpetual',
    'DATA_MANIFEST', 'Expected the declared ETH perpetual raw manifest');
  const dataset = raw.datasets?.find(d => d.type === nativeType);
  requireThat(dataset && ['complete', 'partial'].includes(dataset.status) && dataset.files?.length > 0, 'DATA_MANIFEST', 'Dataset must have verified raw files and explicit coverage');
  const files = dataset.files.filter(f => f.firstTime === undefined || f.lastTime === undefined || (BigInt(f.firstTime) < end && BigInt(f.lastTime) >= start));
  requireThat(files.length > 0, 'DATA_RANGE', 'No raw files overlap the selection');
  const multiplier = contractSizeETH === undefined ? null : exactDecimal(contractSizeETH, 'contractSizeETH');
  if (venue === 'okx' && ['bookTicker', 'trades'].includes(kind)) requireThat(multiplier?.numerator > 0n, 'CONTRACT_UNITS', 'Pin contractSizeETH explicitly; current metadata is not a historical rule schedule');
  const lots = value => {
    const q = exactDecimal(value, 'contracts'), numerator = q.numerator * multiplier.numerator * 1000n, denominator = q.denominator * multiplier.denominator;
    requireThat(numerator % denominator === 0n, 'DATA_PRECISION', 'Contracts do not convert exactly to 0.001 ETH lots');
    return checked(numerator / denominator, 'quantity lots');
  };
  const manifest = {
    venue, kind, nativeType, nativeSymbol: raw.symbol, sourceMarket: 'linear USDT perpetual',
    instrument: { symbol: 'ETH/USDT', currency: 'USDT-micro', lotSize: '0.001', priceTick: '10' },
    units: { price: ['markPrice', 'indexPrice'].includes(kind) ? 'USDT per ETH multiplied by 100000000' : 'microUSDT per 0.001 ETH lot', sizeLots: 'whole 0.001 ETH lots', contractSizeETH: contractSizeETH ?? null,
      rates: 'exact signed numerator/denominator; never rounded to a price' },
    manifestPath: resolve(manifestPath), manifestHash: hash(text), rawDirectory: directory,
    rawCoverage: { status: dataset.status, coverage: dataset.coverage ?? null, missingRanges: dataset.missingRanges ?? [] },
    files: structuredClone(files), window: { startTime, endTime }, publicationDelayMs,
    expectedStepMs: kind === 'bars' || ['markPrice', 'indexPrice', 'premium'].includes(kind) ? 60000 : null,
    limitations: ['Exchange publication timestamps are used with an explicit assumed delay; local receipt times are unavailable.',
      'Displayed book size is market data, not replenished fill liquidity; only ExecutionVenue may model fills, fees, funding, margin and PnL.',
      ...(multiplier ? ['Contract size is an explicitly pinned assumption, not verified historical metadata.'] : []),
      ...(kind === 'bookTicker' ? ['Every selected L2 update is replayed; no sequence IDs are available to prove lossless capture.'] : [])],
  };
  const observation = (time, available, data) => ({ time: String(time), availableAt: String(checked(available + delay, 'publication time')), data: strings(data) });

  async function* records() {
    if (venue === 'binance') {
      const options = { manifestPath, startTime, endTime };
      if (kind === 'bars') {
        const result = await loadBinanceBars({ ...options, intervalMinutes: 1 });
        for (const b of result.bars) yield observation(BigInt(b.closeTime), BigInt(b.availableAt), b);
      } else {
        const result = await loadBinanceSeries({ ...options, type: nativeType });
        for (const row of result.rows) {
          const time = BigInt(row.time ?? row.closeTime);
          const data = ['funding', 'premium'].includes(kind)
            ? { eventId: String(time), rate: rationalStrings({ numerator: BigInt(row.rate ?? row.close), denominator: 100000000n }) }
            : row;
          yield observation(time, BigInt(row.availableAt), data);
        }
      }
    } else if (['bars', 'trades', 'bookTicker'].includes(kind)) {
      let previous = null, tradeId = null;
      for (const file of files) {
        let columns, rowIndex = 0, snapshot = false, bids = new Map(), asks = new Map(), bestBid = null, bestAsk = null;
        for await (const { line, lineNumber } of marketArchiveLines(directory, file)) {
          rowIndex++;
          if (kind === 'bookTicker') {
            const header = /^\{"instId":"ETH-USDT-SWAP","action":"(snapshot|update)","ts":"(\d+)"/.exec(line.slice(0, 160));
            requireThat(header, 'BOOK_SCHEMA', 'Invalid OKX L2 record header');
            const time = nat(header[2], 'book timestamp');
            requireThat(previous === null || time >= previous, 'DATA_ORDER', 'Book timestamps regress; data is never sorted'); previous = time;
            // Still drain and verify the entire archive, without decoding unselected future payloads.
            if (time >= end) continue;
            const row = JSON.parse(line);
            if (row.action === 'snapshot') { bids.clear(); asks.clear(); bestBid = bestAsk = null; snapshot = true; }
            requireThat(snapshot, 'BOOK_SNAPSHOT', 'A snapshot must precede updates in every archive');
            for (const [levels, book, isBid] of [[row.bids, bids, true], [row.asks, asks, false]]) {
              requireThat(Array.isArray(levels), 'BOOK_SCHEMA', 'Book sides must be arrays');
              const seen = new Set();
              for (const level of levels) {
                requireThat(Array.isArray(level) && level.length >= 2, 'BOOK_SCHEMA', 'Invalid book level');
                const p = price(level[0]), size = lots(level[1]);
                requireThat(!seen.has(p), 'BOOK_DUPLICATE', 'Duplicate price within one book message'); seen.add(p);
                if (size === 0n) book.delete(p);
                else { book.set(p, size); if (isBid && (bestBid === null || p > bestBid)) bestBid = p; if (!isBid && (bestAsk === null || p < bestAsk)) bestAsk = p; }
              }
              requireThat(book.size <= 10000, 'BOOK_SIZE', 'Unexpected depth growth; require a fresh snapshot');
              if (isBid && !book.has(bestBid)) bestBid = [...book.keys()].reduce((a, b) => a === null || b > a ? b : a, null);
              if (!isBid && !book.has(bestAsk)) bestAsk = [...book.keys()].reduce((a, b) => a === null || b < a ? b : a, null);
            }
            requireThat(bestBid !== null && bestAsk !== null, 'BOOK_EMPTY', 'An empty side cannot produce a valid best quote');
            const data = strings({ eventId: `${file.sha256}:${rowIndex}`, bid: bestBid, ask: bestAsk, bidSizeLots: bids.get(bestBid), askSizeLots: asks.get(bestAsk) });
            requireThat(validQuote(data), 'BOOK_QUOTE', 'Bend rejected a zero-size, locked or crossed best quote');
            if (time >= start) yield observation(time, time, data);
          } else {
            const expected = kind === 'bars' ? 'instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm' : 'instrument_name,trade_id,side,price,size,created_time,source';
            if (lineNumber === 1) { requireThat(line.replace(/^\uFEFF/, '') === expected, 'DATA_CSV_HEADER', 'Unexpected OKX CSV schema'); columns = expected.split(','); continue; }
            const fields = line.split(',');
            requireThat(fields.length === columns.length && fields[0] === 'ETH-USDT-SWAP', 'DATA_CSV', 'Malformed row or wrong instrument');
            const row = Object.fromEntries(columns.map((key, i) => [key, fields[i]])), time = nat(row.open_time ?? row.created_time, 'timestamp');
            requireThat(previous === null || time >= previous, 'DATA_ORDER', 'CSV timestamps regress; data is never sorted'); previous = time;
            if (kind === 'bars') {
              requireThat(row.confirm === '1', 'BAR_INCOMPLETE', 'Unconfirmed candles cannot be published');
              const data = bar([row.open, row.high, row.low, row.close], time);
              data.volumeLots = scaledDecimal(row.vol_ccy, 100000000n, 'ETH volume') / 100000n;
              exactDecimal(row.vol, 'contract volume'); exactDecimal(row.vol_quote, 'quote volume');
              if (time >= start && data.availableAt <= end) yield observation(data.closeTime, data.availableAt, data);
            } else {
              const id = nat(row.trade_id, 'trade id');
              requireThat(tradeId === null || id >= tradeId, 'TRADE_ORDER', 'Trade IDs regress'); tradeId = id;
              requireThat(['buy', 'sell'].includes(row.side), 'TRADE_SIDE', 'Unknown aggressor side');
              const size = lots(row.size); requireThat(size > 0n, 'TRADE_SIZE', 'Trade size must be positive');
              const data = { eventId: row.trade_id, side: row.side, price: price(row.price), sizeLots: size, source: row.source };
              if (time >= start && time < end) yield observation(time, time, data);
            }
          }
        }
      }
    } else {
      requireThat(files.length === 1, 'DATA_MANIFEST', 'API series require one combined verified JSON file');
      const verified = await verifyMarketFile(directory, files[0]);
      requireThat(files[0].bytes <= 64 * 1024 ** 2, 'DATA_SIZE', 'API series exceeds 64 MiB');
      const rows = JSON.parse(await readFile(verified.path, 'utf8'));
      let previous = null;
      for (const row of rows) {
        const rate = kind === 'funding' || kind === 'premium', time = nat(rate ? row.fundingTime ?? row.ts : row[0], 'timestamp');
        requireThat(previous === null || time >= previous, 'DATA_ORDER', 'API timestamps regress'); previous = time;
        if (rate) {
          requireThat(row.instId === 'ETH-USDT-SWAP', 'DATA_SYMBOL', 'Wrong API instrument');
          const value = exactDecimal(kind === 'funding' ? row.fundingRate : row.premium, 'rate', { signed: true });
          if (time >= start && time < end) yield observation(time, time, { eventId: String(time), rate: rationalStrings(value) });
        } else {
          requireThat(row.at(-1) === '1' && time % MINUTE === 0n, 'BAR_INCOMPLETE', 'Require confirmed aligned price bars');
          const [open, high, low, close] = row.slice(1, 5).map(v => scaledDecimal(v, 100000000n, 'reference price'));
          requireThat(low > 0n && low <= open && low <= close && high >= open && high >= close, 'BAR_OHLC', 'Invalid reference OHLC');
          if (time >= start && time + MINUTE <= end) yield observation(time + MINUTE - 1n, time + MINUTE, { openTime: time, closeTime: time + MINUTE - 1n, availableAt: time + MINUTE, open, high, low, close });
        }
      }
      await unchangedFile(verified);
    }
    requireThat(hash(await readFile(manifestPath, 'utf8')) === manifest.manifestHash, 'DATA_SOURCE_CHANGED', 'Raw manifest changed during processing');
  }
  return Object.freeze({ manifest: freeze(manifest), records });
}
