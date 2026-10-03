# Signal-to-target workflow

## Local counterparts

| Trading concept | Local interface |
| --- | --- |
| Initialization | Construct configured source, venue and a fresh strategy factory in the worker |
| Incoming market event | `runStrategy` callback or a bar strategy's `onBar` interface |
| Historical/indicator state | Bounded information `history`, `RollingFeatures`, or precomputed causal observations |
| Desired holdings | Canonical total lot string through `targetPosition` or the callback |
| Account/working orders | Frozen `account`, `ledger`, `orders`, `equity` in the strategy context |
| Realized execution/audit | Venue report and `readReplayAudit`, not a signal callback's prediction |
| Scheduled logic | Explicit observation/timestamp/tick-count logic or worker-side model preparation; no generic calendar scheduler |

These are conceptual translations. Do not generate vendor method names or assert a one-to-one event-handler API.

The built-in `meanReversion` uses quote bid/ask midpoints. A close-bar rule needs the corresponding bar-data calculation; it cannot pass close-only rows directly to that helper.

## Target semantics

Return `'12'` to request a total position of 12 lots, not another buy of 12. Return `'0'` to request flat exposure. Return `null` to skip reconciliation; it does not cancel a working order. Signed targets are allowed by the generic strategy seam, but the cash venues reject negative targets. The derivative venue admits shorts.

`targetPosition(target, { maxPositionLots, warmup })` can clamp signal intent and declare history readiness. The venue still enforces its own cap, prices, capital, reservations, margin and costs. Strategy-level clipping does not guarantee feasibility or cancel an already executed fill. Exposure limits are a parameter of the requested risk policy, not an automatic permission to enlarge a user's position.

The context's `history` contains information data only, oldest-to-newest. `observation` is the current data, `time` is its availability time, `tickCount` counts total observations, and `orders` contains normalized working orders only. Read ledger quantities as BigInt/canonical strings. Size risk from venue equity with source-derived volatility, never mark the account with an unrelated information price.

## Warmup and state

Set `strategy.lookback` to cover the largest dependency, including an extra preceding observation when returns/channel definitions need it. Use one shared feature-update path. Return `null` when information/features are not ready. A `'0'` warmup return could liquidate an existing position and is not equivalent to skipping a decision.

In an `evaluateStudy` preparation callback, provide fresh strategy/venue factories and enough preceding information for history-only warmup. The callback is not invoked before validation, so mutable indicator objects must initialize from that available history or live in a precomputed information source. Accounts reset; do not carry fitted mutable trading state from another variant.

Suppressed warmup callbacks still advance the venue. Its admitted window and event/funding coverage must include warmup publication timestamps; starting a derivative venue only at validation fails coverage. Performance sampling starts at validation.

For cooldowns, exits and state transitions, derive execution-sensitive changes from actual holdings/fills. A pending flat target can remain partly filled while cancellation is in flight; sending a signal is not the start of an actual post-exit cooldown. The existing volatility breakout strategy handles this pattern and is a better starting point than new ad hoc order logic.

Record the counting convention: that implementation permits re-entry at `observedExitIndex + cooldownBars`. Blocking two complete subsequent decision bars requires a different boundary. A callback detects the first observed flat account, which can be later than the actual fill; a fill-time policy needs explicit fill evidence.

## Basis

Local: `src/adapter-contracts.d.ts`, `src/strategies.mjs`, `src/bar-strategies.mjs`, `src/replay.mjs`, `src/study.mjs`, `docs/ADAPTERS.md`.

Distilled from [Event Handlers](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/event-handlers), [Position Sizing](https://www.quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/position-sizing), [Algorithm Framework](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/overview) and [Warm-Up Periods](https://www.quantconnect.com/docs/v2/writing-algorithms/historical-data/warm-up-periods). The local target-only architecture replaces those vendor code interfaces.
