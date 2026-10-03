# Information and execution interfaces

`runStrategy(informationSource, executionVenue, strategy, { lookback })` composes
two independent adapters. `runBarStrategy(source, venue, strategy, { historyLimit })`
uses the same runner with the existing `onBar` signal interface. Neither runner
constructs an execution venue or falls back to information data for execution.
Structural types are in [adapter-contracts.d.ts](../src/adapter-contracts.d.ts).

Quote replay bounds history to `strategy.lookback` by default, or 256 observations
when undeclared. Set `lookback: 'all'` for complete history, or supply a positive
integer at least as large as the declared requirement. Use `tickCount` for elapsed
observations; `history.length` describes only the visible window.

| Module | Owns | Interface |
| --- | --- | --- |
| InformationSource | Market/features observations, publication timestamps and source provenance | `instrument`, `manifest`, `observations()` |
| Strategy/model | Signals and desired exposure | Frozen context → canonical target lot string or `null` |
| ExecutionVenue | Order reconciliation/admission, prices, fills, fees, funding, liquidity, margin, valuation and PnL | `instrument`, `manifest`, `advanceTo(time)`, `snapshot()`, `setTarget(target,time)`, `finish(time)`, `report()` |
| Replay runner | Availability ordering, bounded information history and independent provenance | Composes the three interfaces above |

The interfaces are synchronous replay interfaces. Live transports, asynchronous
order acknowledgments and reconnect/recovery protocols are not implemented.

## Admit streams before replay

`prepareInformationSource({ id, instrument, observations, directory, datasetHash? })`
accepts synchronous or asynchronous observations, validates their publication
order, and persists them without retaining the full input. It returns the same
synchronous information interface, plus `close()`. Preparation must finish before
a strategy runs: a failed stream or final archive check never publishes a complete
source. The directory must be new; partial attempts are retained for inspection.

For verified processed market shards, use
`loadProcessedInformationSource({ manifestPath, directory, startTime?, endTime?, allowGaps? })`.
This path streams directly into preparation without the in-memory row cap. Omit
`directory` for the existing in-memory path, which defaults to `maxRows: 100000`.
`maxRows` is only accepted for that in-memory path. Both paths retain the original
dataset identity and separately hash the selected observations.

`openPreparedInformationSource(manifestPath, { id? })` verifies a saved source and
opens fresh cursors for another process or study. The prepared source exposes its
descriptor at `source.manifest.audit`; reopening permits a different routing ID
without changing the observation identity. Close it after all replays complete.

Execution quotes can independently use
`await prepareQuoteData(ticks, { instrument, directory })`, where `ticks` is a
synchronous or asynchronous iterable of executable model quotes. Pass the returned
dataset directly as `ticks` to `quoteInformationSource` and/or
`QuoteExecutionVenue`. `openQuoteData(manifestPath)` reopens it. Each dataset owns
its readers; call `dataset.close()` after all dependent replays finish. These
adapters do not turn informational prices or displayed book sizes into executable
liquidity.

## Compose independently

```js
import {
  barInformationSource, BarExecutionVenue, createBarStrategy, runBarStrategy,
} from './src/index.mjs';

const source = barInformationSource({
  id: 'binance/archive', instrument: canonicalInstrument, bars: signalBars,
});
const venue = new BarExecutionVenue({
  id: 'hyperliquid/cash-price-proxy', config: executionConfig,
  bars: executionBars, maxPositionLots: '1000',
  halfSpreadBps: '2', participationBps: '10',
});
const strategy = createBarStrategy({
  type: 'ma-cross', quantity: '1000', fast: 12, slow: 48,
});
const report = runBarStrategy(source, venue, strategy).report();
```

`signalBars` and `executionBars` are separately supplied, normalized datasets.
Replacing either adapter does not change this strategy. The same composition
supports Binance → Hyperliquid, Hyperliquid → Hyperliquid, or OKX → Kraken when
adapters/data for those markets are supplied. Names are provenance identifiers;
setting an ID does not implement an exchange connector or calibrate execution.
For same-market research, pass the same dataset explicitly to both adapters.

Shipped adapters are `InformationSource` for arbitrary market/features data,
`quoteInformationSource`, `barInformationSource`, `QuoteExecutionVenue` for Bend
cash quote replay, and `BarExecutionVenue` for the declared cash-price proxy.
`DerivativeExecutionVenue` adds linear/inverse futures and perpetuals with signed
positions, funding, margin and expiry; see [DERIVATIVES.md](DERIVATIVES.md).
An external venue implements the structural interface directly; inheritance from
the Bend adapters is unnecessary. Reports and accounting from such a venue retain
that venue's own verification scope.

## Units and availability

Both adapters declare canonical `symbol`, `currency`, and `lotSize`. The runner
requires exact agreement. Native exchange symbols, contract multipliers, quote
currency conversion and price scaling must be normalized explicitly upstream.
Price ticks may differ between source and venue. Identical ticker text alone is
not evidence that spot and derivative contracts or USDT and USDC are equivalent.

An observation has `{ time, availableAt, data }`. `time <= availableAt`; publication
times must not decrease. Generic sources can express delayed features; quote
and completed-bar factories keep their existing stricter input validation.
The runner advances the venue through **all** its events at or before
`availableAt`, then calls the strategy, then passes only `(target, availableAt)`
to the venue. Equal-time venue events precede every decision at that timestamp.
In the Bend venues, an order fills strictly after its decision and no earlier
than its configured arrival. No venue data after the decision time is visible in
the account snapshot. A gap in information does not stop venue events progressing
when the next observation arrives.

The replay ends at the last information availability time. Supply an observation
with a `null` signal at the desired terminal time if execution must continue after
the last actionable signal. The runner never drains future venue events or
liquidates implicitly. Empty sources finish with `null`. A venue can be used for
only one replay, including a failed attempt.

## Strategy and account context

The frozen context contains `observation`, `history`, `time`, `index`, `tickCount`,
and `account`. `ledger`, `orders` and `equity` expose the corresponding venue
snapshot fields for existing rule/model callbacks. `onBar` additionally gets
`bar`, the current information observation. History contains only information
observations, and orders contain only normalized working orders (plain `buy` /
`sell` sides, with no Bend constructors). The venue's report retains full order
and fill history.

Strategies return a signed canonical target lot string, or explicit `null`
to skip reconciliation. `'0'` requests flat exposure. Arrays of submit/cancel
orders are rejected. `targetPosition`, `buyAndHold`, `movingAverageCrossover` and
`meanReversion` generate these targets; they accept no fee settings. Optional
strategy exposure caps are intent limits. The venue independently enforces its
mandatory `maxPositionLots`, capital, fees, stale-quote policy and order rules.
An intent is not a guarantee of execution. Built-in strategies remain long/flat;
cash venues still reject short targets. `targetPosition` supports signed intent
with a cap on its absolute magnitude; the derivative venue admits shorts.

Equity always comes from the venue. For example, breakout risk sizing uses that
equity with information-source volatility; it never values positions using the
information-source close. Funding and margin state are read-only venue fields.
Callbacks and adapters remain trusted JavaScript; freezing does not sandbox
closures, network access, direct engine access or filesystem reads.

## Execution models and reports

`QuoteExecutionVenue` uses only its own validated quote stream, instrument ticks,
fee schedule, order/cancel latency and capital configuration. No execution quotes
means no fills or marks, even if the information source has prices and volume.
Stale venue quotes prevent new reconciliation, and stale terminal inventory
marks invalidate performance through the existing Bend host contract.
Target reconciliation is private venue implementation: it reads the resolved
target, venue quote, ledger and working orders directly. Strategy warmup and
information history remain with the strategy and replay runner.

`BarExecutionVenue` owns its spread, collar, delay, participation and liquidity
cap. The collar uses its own latest completed close; the opening liquidity budget
uses its own previous completed volume. It can consume information bars with a
different cadence. The source's bars never supply execution prices, liquidity or
terminal marks. Its final venue bar does not accept new orders.

These two venues are cash-only. Funding is explicitly unsupported and margin
is cash-only without leverage; zero funding is not presented as a perpetual
simulation. `DerivativeExecutionVenue` implements funding, margin, liquidation,
linear/inverse P&L and dated settlement; its assumptions are in [DERIVATIVES.md](DERIVATIVES.md).
The runner does not compute or
override economic report fields and does not attach Bend proof claims to foreign
venue reports.

Reports add `routing.informationSource` and `routing.executionVenue` manifests
and a signal hash. Built-in manifests separately bind information observations,
execution data and execution settings. Keep both datasets/configurations as
experiment dependencies. Source changes and venue changes invalidate different
provenance fields. Cash venues' `venue.backtest` exposes the built-in engine for audit and
checkpoints; appending to it after completion invalidates the venue report.
Engine checkpoints capture execution only; strategy/source continuation requires
its own state or replay.

## Durable cash replay audit

Supply `auditDirectory` to a cash venue to persist events, order history, fills,
valuations and trace in an indexed disk recording. Disk recording requires
`orderStorage: 'active'` and `traceMode: 'compact'`. Together with prepared quotes
and bounded strategy history, this removes retention proportional to the number
of completed events and orders from the live replay. Working orders and pending
cancellations still require memory. Array inputs remain resident in memory.

```js
const executionData = await prepareQuoteData(executionTicks, {
  instrument: config.instrument, directory: 'output/execution-data',
});
let source;
try {
  source = await loadProcessedInformationSource({
    manifestPath: 'output/processed/manifest.json', directory: 'output/information-data',
  });
  const venue = new QuoteExecutionVenue({
    id: 'execution', config, ticks: executionData, maxPositionLots: '1000',
    auditDirectory: 'output/replay-audit',
  });
  const report = runStrategy(source, venue, strategy).report();
  // report.audit binds the complete persisted recording; economics stay inline.
} finally {
  source?.close();
  executionData.close();
}
```

Disk `report()` seals the recording and returns summary economics and an audit
descriptor; report before disposing the replay. `readReplayAudit(report.audit,
'fills')` iterates verified persisted records without loading all of them.
`report({ detail: 'full' })` explicitly materializes history and requires memory
proportional to that history. Memory recording remains the default when no audit
directory is supplied. Failures abort disk recording; an incomplete attempt has
no completed manifest. Retain both the manifest and its database when moving or
archiving evidence. Filesystem storage and SQLite are tested host implementation,
outside the Bend proof scope.

The current `bend-replay-audit-v2` format stores chronological streams in
compressed chunks, while exact event/order identity indexes stay on disk.
Chunks target at most 512 records or 256 KiB of canonical record bytes; an
individual larger observation may exceed that byte target. Pending chunks and
SQLite transactions are flushed before checkpoints and final publication. Any
write failure still aborts the whole recording. Logical records, ordering and
canonical hashes are independent of the physical chunk layout. Read v1 audit
files with the original toolkit; prepare new datasets for this format.

For concurrent tick research, admit the dataset once before enqueueing jobs.
Declare both its manifest and database as experiment dependencies. Each worker
opens its own read-only admitted dataset and owns a separate `auditDirectory`;
reuse the opened dataset across that worker's trials, then close it. Do not copy
the same source database into every attempt or request full reports in the
normal campaign path. Queue concurrency is per runner, so five independent
agents should coordinate the total number of worker processes on the host.

Capacity is measured in events and bytes per observation, not calendar years.
The quote execution model consumes top-of-book prices and sizes. Full depth
observations can be prepared as information, but this does not implement depth
matching, queue position or exchange microstructure. Array-backed bar and
derivative inputs remain memory-resident. Public array getters, full reports,
and full-prefix checkpoints retain their explicitly documented costs.
