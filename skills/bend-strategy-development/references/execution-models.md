# Choose the economic model before interpreting fills

## Existing venues

| Venue | Supported economics and important boundary |
| --- | --- |
| `QuoteExecutionVenue` | One-instrument cash, supplied bid/ask and separate per-side liquidity budgets, integer per-lot fee, order/cancel latency; no shorts/leverage/funding |
| `BarExecutionVenue` | Cash-price proxy using separately supplied completed bars, assumed spread/collar/delay and previous completed volume; no perpetual accounting or intrabar stop path |
| `DerivativeExecutionVenue` | Single linear/inverse future or perpetual, signed targets, proportional fees, supplied funding/marks, margin, FIFO P&L, liquidation and dated settlement |

Use `docs/DERIVATIVES.md` for contract multipliers, settlement units, inverse rounding, funding schedules and liquidation assumptions. Funding events must cover every due slot, including explicit zero rates. The liquidation rule is a declared adverse-mark stress close that bypasses quote liquidity, not an exchange auction. There is no multi-asset collateral/portfolio margin, insurance fund or automatic continuous-contract roll.

## Causality and reservations

All venue events at a decision timestamp occur before the decision. A fill must be strictly later and satisfy exchange arrival. Same-time effective cancellation precedes fills. Partial fills consume a shared shrinking per-side budget; no side budget carries forward. A new unique quote replenishes the declared budget, which remains a model assumption.

Cash admission reserves all working exposure. The venue reconciles target changes, cancels stale/conflicting orders and waits for cancellation to become effective before replacement. In-flight fills remain possible. The derivative venue similarly waits and may require another signal after delayed cancellation. Do not stack a replacement assuming `null` or a cancellation request eliminated the old order.

Freshness limits apply to venue quotes/marks. Information gaps do not suspend the venue: its events advance when the next decision arrives. The runner stops at the last information availability time. If the study needs a later terminal boundary, supply an explicit observation and a null signal at that boundary, with a compatible source contract; it never silently drains future events.

## Exits and costs

An observed OHLC high/low touch does not reveal a tradable stop fill or the order of intrabar extrema. The bar strategies make completed-bar exit decisions and execute under the next eligible venue event. Cash fees are charged by the ledger; spread is already in quotes. Do not add another arbitrary slippage debit to the reported fill.

For stress comparisons, vary fee/spread, participation, latency and staleness through the actual venue configuration. A fabricated named exchange ID cannot calibrate those parameters. Preserve their different execution identities and report them as stress scenarios rather than mixing incompatible studies through `selectStudy`.

Open holdings and unrealized losses remain at termination; no implicit liquidation or hypothetical cash exit fee is invented. Stale terminal inventory marks invalidate normal performance. A position cap cannot undo fills or guarantee an immediate exit.

## Continuation and evidence

Cash engine checkpoints retain event/accounting replay, not strategy/model/source state. Version-3 disk checkpoints also require their referenced audit artifacts. Derivative continuation currently requires deterministic replay; it does not inherit the cash checkpoint interface. Preserve feature/model state separately or replay it.

Reuse `readReplayAudit(report.audit, 'fills')` to inspect complete fills without hydrating all report arrays. Keep the manifest and database together. Formal claims cover the declared Bend laws; model economics, host matching/orchestration, vendor data and external venue implementations have their separate tested boundaries.

## Basis

Local: `docs/CONTRACT.md`, `docs/ADAPTERS.md`, `docs/DERIVATIVES.md`, `docs/ETH_EXPERIMENTS.md`, `src/execution-venue.mjs`, `src/bar-execution-venue.mjs`, `src/derivative-execution-venue.mjs`.

Distilled from [Reality Modeling](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/key-concepts), [Trade Fills](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/trade-fills/key-concepts), [Order Tickets](https://www.quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/order-management/order-tickets) and [Stop Market Orders](https://www.quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/order-types/stop-market-orders). Vendor order-type support is not implied by this translation.
