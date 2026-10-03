# Market-data processing

Binance remains the primary information source. Processing OKX creates local
data artifacts; it never selects an execution venue or changes a campaign.

The interface is `openMarketSource(configuration)` followed by
`prepareMarketData({ source, outputDirectory })`. Both Binance and OKX adapters
emit `{ time, availableAt, data }` observations with the same schema for each
kind. `readProcessedData` streams those observations; the bounded
`loadProcessedInformationSource` bridge implements the existing data-only
InformationSource interface. Models and strategies need no vendor parsers.

## Supported data and units

| Kind | Binance | OKX | Canonical data |
| --- | --- | --- | --- |
| `bars` | Existing verified minute-bar loader | Confirmed candle ZIPs | Existing eight-field bar schema |
| `markPrice`, `indexPrice` | Verified auxiliary ZIPs | Verified API JSON | Completed price OHLC, scale 1e8 USDT/ETH |
| `premium` | Close of completed premium-index bar | Native premium observation | Exact signed rational rate |
| `funding` | Funding archive | Funding settlements | Exact signed rational rate |
| `trades` | Not yet adapted | Trade ZIPs | Native ID, side, exact price and size |
| `bookTicker` | Not available in this local archive | Replayed 400-level L2 | Best bid/ask and displayed sizes per event |

Trade/bar/book prices are microUSDT per 0.001 ETH lot, matching the existing
Binance bar loader. Sizes are whole 0.001 ETH lots. Candle volume floors only
after exact decimal conversion, as in the existing minute-bar loader. Rates
retain reduced numerator/denominator strings; the OKX adapter admits precision
beyond the Bend runtime's bounded Nat range. Binance retains its existing exact
1e8-scale admission limit. Rates are data, not accounting postings.
Reference-price OHLC uses its separately declared 1e8 scale.

OKX contracts require an explicit `contractSizeETH` for trades/books. The sample
pins `0.1`, based on the downloaded current reference. This is an assumption
about the historical period, not a historical specification guarantee. Other
symbols and inverse contracts are rejected rather than guessed.

Premium sources share a representation, not necessarily a calculation method.
The source manifest retains the native dataset type and venue. Candle closes
become available after the inclusive close timestamp; other observations use
their native timestamp. `publicationDelayMs` adds an explicit assumed delay.
Zero delay is an assumption: the archives do not supply local receipt times.

## Cleanup and publication

- Raw data remains unchanged. Each attempt exclusively owns a separate output
  directory. Concurrent writers cannot take over an existing attempt.
- Selected inputs pass SHA-256/byte-length admission through Bend. Streaming
  ZIP/ZIP64 and TAR readers check decompressed CRCs and bounded row sizes.
- Decimal parsing and unit conversion use BigInt. Off-grid prices, inexact
  quantities, regressions, malformed records and conflicting identities fail
  the attempt. Data is never sorted to hide chronology errors.
- Among observations admitted by a source adapter, identical stable identities
  are deduplicated and counted. Book messages lack
  exchange sequence IDs, so each raw message retains its file/row identity;
  identical displayed prices do not imply duplicate events.
- Snapshots replace the book; updates set quantities or delete zero quantities.
  Every selected update is replayed. Missing initial snapshots and invalid best
  quotes fail closed. There is no interpolation, forward-filled synthetic tick,
  outlier winsorization or inferred liquidity replenishment.
- Missing regular observation buckets remain explicit. Readers reject gaps
  unless `allowGaps: true` is supplied. Irregular trade/book streams report
  observed coverage, not a claim that every exchange event was captured.
- Output is streamed into daily gzip JSONL shards. Only a final complete,
  checksummed manifest makes them readable. Failed attempts retain a failure
  manifest and any partial files for diagnosis. Use a new directory to retry a
  failed or changed recipe; identical completed recipes are verified and reused.

The existing Binance loader keeps its stricter admission rules: incomplete raw
datasets, duplicate rows and missing minutes are rejected before processing.
`allowGaps` applies to published processed artifacts and cannot bypass those
source checks. OKX admits verified partial series, so its processor can publish
explicit gap counts and deduplicate identical records.

The manifest binds source hashes, selection, units, assumptions, cleanup policy,
toolkit/build evidence, dependency lock, shard hashes and quality counts. The
dependency lock records package versions; third-party archive code and vendor
data are not formally proved.

## Run and read

```powershell
# Select the locally installed distribution if it differs from the default.
$env:BEND_WSL_DISTRO = 'Debian'
npm run build
npm run data:process -- examples/process-binance.json
npm run data:process -- examples/process-okx.json
npm run data:process -- examples/process-okx-book.json
```

The book example selects the first five minutes of September 15 for a bounded
real-data check. It verifies the whole selected compressed daily archive while
replaying book payloads through the end of the selection. Change the explicit
window and output directory for larger processing runs; full-month BBO output
is not implicitly generated by this example.

```js
import { readProcessedData, asOfMarketData } from './src/index.mjs';
const records = readProcessedData({ manifestPath });
for await (const sample of asOfMarketData(records, decisionTimes, { maxAgeMs: '1000' })) {
  // sample.observation is null when unavailable or stale. No future row escapes.
}
```

`asOfMarketData` uses Bend's inclusive publication-visibility policy, preserves
same-time input order, and measures age from the observation timestamp.
Execution remains strictly later under the separate venue policy. Displayed
book sizes are never returned as fill budgets. ExecutionVenue alone owns order
construction, fills, fees, funding cashflows, margin, liquidity assumptions and
PnL. This data infrastructure does not implement a perpetual execution engine.
