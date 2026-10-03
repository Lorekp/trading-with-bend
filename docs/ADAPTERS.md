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

Strategies return a nonnegative canonical target lot string, or explicit `null`
to skip reconciliation. `'0'` requests flat exposure. Arrays of submit/cancel
orders are rejected. `targetPosition`, `buyAndHold`, `movingAverageCrossover` and
`meanReversion` generate these targets; they accept no fee settings. Optional
strategy exposure caps are intent limits. The venue independently enforces its
mandatory `maxPositionLots`, capital, fees, stale-quote policy and order rules.
An intent is not a guarantee of execution. Built-in strategies remain long/flat;
this interface does not add short selling to their declared input domain.

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

Both shipped venues are cash-only. Funding is explicitly unsupported and margin
is cash-only without leverage; zero funding is not presented as a perpetual
simulation. A derivative venue must implement its own funding, margin,
liquidation and valuation within this interface. The runner does not compute or
override economic report fields and does not attach Bend proof claims to foreign
venue reports.

Reports add `routing.informationSource` and `routing.executionVenue` manifests
and a signal hash. Built-in manifests separately bind information observations,
execution data and execution settings. Keep both datasets/configurations as
experiment dependencies. Source changes and venue changes invalidate different
provenance fields. `venue.backtest` exposes the built-in engine for audit and
checkpoints; appending to it after completion invalidates the venue report.
Engine checkpoints capture execution only; strategy/source continuation requires
its own state or replay.
