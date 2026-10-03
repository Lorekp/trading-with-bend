# Causal features, history and resampling

## Use the existing feature seam

`RollingFeatures(schema)` and `computeFeatures(rows, schema)` share one streaming/batch implementation. The schema binds ordered names, source fields, units, kind and trailing parameters. Available kinds include value, lag, mean, standard deviation and return; verify `featureSchema` before choosing a definition. The input is `{ time, availableAt, values }`, not an execution quote. Features include availability and a content/schema hash.

Windows are trailing and may include the current published observation. Warmup produces incomplete values and `ready: false`; inference rejects them. Define whether a channel/reference should exclude the current observation before coding it. The local `history` array is oldest-to-newest, and `history.at(-1)` is current; do not transplant a vendor rolling-window's reversed indexing.

Keep one update path per arriving observation. Historical warmup followed by replay must not double count the overlap. Model labels are separate artifacts with their own maturity times. Validate prefix/batch parity on representative inputs and check that changing future rows leaves earlier outputs unchanged.

Do not infer equal semantics from equal tensor shape. A renamed feature, different units, changed window or altered missingness policy changes the contract. A late revision calls for a newly declared stream rather than rewriting a fitted artifact's historical inputs.

## Read history without retaining everything

`runStrategy` uses `strategy.lookback`, otherwise 256 observations, unless explicitly configured. Declare enough lookback for all indicators and use `tickCount` for elapsed observations. `history.length` stops growing at the bound; it cannot implement a retraining clock. An explicit smaller-than-required lookback fails admission. `lookback: 'all'` is an intentional memory-cost choice.

`evaluateStudy` warmup supplies preceding history but does not call the candidate strategy before validation. A stateful feature object in a callback will not initialize itself from those suppressed callbacks. Derive initial state from the supplied history at the first evaluation decision or explicitly precompute causal features in the information source. Use fresh state per fold/variant.

For larger sources, `prepareInformationSource` admits data before synchronous replay; `openPreparedInformationSource` reopens it for another worker. `loadProcessedInformationSource` with a new `directory` streams into preparation; its in-memory path has a row bound. `prepareQuoteData`/`openQuoteData` separately own executable quote storage. Close datasets only after dependent replays finish.

## Resample only with a declared clock

The existing `loadBinanceBars({ intervalMinutes, ... })` supports the repository's completed-bar aggregation. Preserve its availability, gap, volume and integer-rounding rules. Calendar/session-aware generic consolidation is not a universal local service. If a strategy needs one, specify input/output types, interval boundary, exchange/session clock, publication timing, late-data policy and exactly one update path. Do not fabricate intrabar tick paths from OHLC extrema.

Full-depth information, bar/derivative arrays, sequence windows and explicit full reports each have their own memory cost. Calendar duration is not an event-count estimate. Profile the requested source/payload before scaling.

## Basis

Local: `docs/RESEARCH.md`, `docs/ADAPTERS.md`, `src/features.mjs`, `src/replay.mjs`, `src/binance-bars.mjs`.

Distilled from [Rolling Window](https://www.quantconnect.com/docs/v2/writing-algorithms/indicators/rolling-window), [Manual Indicators](https://www.quantconnect.com/docs/v2/writing-algorithms/indicators/manual-indicators), [Consolidating Data](https://www.quantconnect.com/docs/v2/writing-algorithms/consolidating-data/getting-started) and [Historical Data](https://www.quantconnect.com/docs/v2/writing-algorithms/historical-data/history-requests). Local history ordering and warmup semantics are deliberately different.
