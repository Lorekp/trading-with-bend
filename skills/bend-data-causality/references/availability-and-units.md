# Availability and exact market-data identity

## Three clocks

Distinguish observation time (`time`), usable publication time (`availableAt`) and decision time. Generic information observations satisfy `time <= availableAt` and nondecreasing publication order. The quote/completed-bar factories have stricter admission rules; use them only for inputs meeting those rules. Completed bars are available at inclusive `closeTime + 1 ms`, not at their open or nominal last-second label.

`asOfMarketData(records, decisions, { maxAgeMs })` exposes the latest published observation, inclusive at publication, preserving same-time input order. Missing/stale observations become `null`. Age is measured from observation time, not merely from when delayed data arrived. Do not fill a past decision with a future sample or carry forward indefinitely.

In `runStrategy`, the venue advances through all its events at or before an observation's `availableAt` before the signal callback runs. The cash/derivative fill contracts still require execution strictly later than decision time and no earlier than arrival. Visibility and executable timing are different policies.

Raw archives often lack actual local receipt times. A configured `publicationDelayMs` is a declared sensitivity assumption, not measured transport latency. A revised record needs revision publication history or a conservatively documented assumption; replacing earlier history with later corrected values can leak future information.

## Units are part of identity

Use canonical decimal strings and BigInt for admitted prices, quantities, fees and timestamps. Floating-point feature/model values have a separate numerical boundary. Record symbol, currency, lot size, price tick, multiplier and price/settlement scale. The runner requires source and venue to agree on canonical symbol/currency/lot size; identical ticker text is insufficient.

`parseQuoteCsv` requires explicit column maps and `QUOTE_UNITS`. Existing Binance/OKX data adapters own exact decimal parsing and vendor-specific normalization. Inspect `docs/MARKET_DATA.md` and `docs/DERIVATIVES.md` before combining reference-price scale, spot price per lot, inverse contract value or settlement minor units. An OKX contract-size assumption derived from current metadata does not establish its historical validity. USDT and USDC are not interchangeable collateral by naming convention.

## Admission, gaps and liquidity

`prepareMarketData({ source, outputDirectory })` publishes immutable, checksummed daily shards only after complete admission. Preserve partial failures for diagnosis. Declare the manifest and all selected shards/raw dependencies in experiment registration. Readers reject regular-series gaps unless `allowGaps` explicitly applies; it cannot override a source loader's stricter input requirements.

Input chronology errors are errors, not a reason to sort records. Preserve stable identities; identical IDs/content may deduplicate, changed content must fail. Book snapshots replace state and updates mutate quantities; equal displayed prices are not evidence of duplicate exchange messages. Irregular streams report observed coverage, not guaranteed capture of every event.

Processed L2/BBO observations are information. `loadProcessedDerivativeData` accepts a separately explicit execution proxy, including displayed-size participation or bar-volume/spread assumptions. Neither proxy establishes queue position or actual historical fills. Funding data becomes a cashflow only through the derivative venue's declared contract and schedule; missing funding is not a zero rate.

## ETH intraday admission

Before a bounded cross-venue study, produce an inventory for the exact selected interval and files:

- Verify manifest/archive hashes and actual source/venue overlap, including warmup and terminal boundaries; a complete manifest flag or monthly filename is insufficient. Required missing streams fail explicitly. Inspect gaps, L2 snapshot/update reconstruction and checksums where available, and stale BBO/marks.
- Distinguish exchange event, publication and measured receipt times. Historical timestamps without local receipt evidence cannot establish a subsecond cross-venue lead/lag advantage. Record publication-delay assumptions and their stress range.
- Freeze canonical instrument/settlement units, multiplier, tick/lot size, margin and fee tier. Retrieval-time instrument metadata needs an explicit historical-contract assumption; it is not historical specification evidence.
- Cover every funding slot needed by the venue, including zeros, with marks and settlement inputs. Ex-post settled funding is an execution cashflow, not a pre-settlement forecast. A funding/premium signal requires defensible publication-time history for the value visible at each decision.
- Declare displayed-size participation or candle spread/volume proxies, taker costs, latency, partial-fill behavior and capacity limits independently from signal data. Candles alone support a labeled execution proxy, not calibrated executable perpetual evidence.

Snapshot only required exploration files through campaign `inputFiles`; final market values remain coordinator-owned. Record known previous period exposure before assigning confirmation windows. Use `docs/MARKET_DATA.md`, `docs/DERIVATIVES.md` and current loaders as the authoritative contracts rather than assuming the ETH demo's older inventory covers all downloaded data.

## Basis

Local: `docs/MARKET_DATA.md`, `docs/ADAPTERS.md`, `docs/DERIVATIVES.md`, `src/market-data.mjs`, `src/adapter-contracts.d.ts`.

Distilled from [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), [Timeslices](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/time-modeling/timeslices), [Periods](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/time-modeling/periods) and [Security Identifiers](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/security-identifiers). These local timestamp/unit rules take precedence over vendor engine examples.
