# Execution, arithmetic and verification contract

## Domain

One configured spot instrument and quote currency; zero initial inventory; positive initial cash; no borrowing or leverage. All lots are indivisible. Cash, prices and fees are quote minor units. The fixed fee is nonnegative and charged per filled lot once. A sale limit below the per-lot fee is rejected. Sell proceeds are immediately usable by subsequent events. No corporate actions, funding, deposits, withdrawals, delistings or settlement events are modeled; adding them requires new typed events and postings.

Bend's mathematical `Nat` is exact and unbounded in these laws, but its pinned JavaScript backend checks a `2^48 - 1` immediate bound. The adapter restricts input integers and relevant computed values to that bound, uses BigInt for reconciliation, and converts runtime arithmetic failure to a typed error. `Nat.sub` saturates: the pure low-level posting functions therefore require sufficient cash/inventory. The admitted-state invariants, runtime reconciler and tests establish those preconditions for the public framework path. Never use `Engine.buy` or `Engine.sell` directly on unchecked data.

## Event order and fills

The accepted stream is sorted by nondecreasing timestamp and strictly increasing causal sequence. The engine never sorts bad input for the caller. IDs are unique across all event types; an identical duplicate is an idempotent delivery, while changed content is an error. Rejected order IDs cannot be reused. Amendments are unsupported.

Submission changes reservations only. Admission checks the full portfolio plus all working orders; a buy reserves `(limit + fee) * remaining`, and a sell reserves remaining inventory. Partial fills recompute reservations. Before each event the engine makes cancellations with `cancel_at <= event.time` effective. The earlier of repeated cancellation requests wins. Cancel and submit latency are separate, fixed milliseconds; same-time effective cancellations run before fills. Reports are delivered with zero additional latency.

A fill requires `execution_time > decision_time` and `execution_time >= exchange_arrival`. Buy fills execute at the supplied ask no higher than the limit. Sell fills execute at the bid no lower than the limit. Orders traverse submission FIFO; a nonmarketable order does not block later marketable orders. Buy orders share ask liquidity; sell orders share bid liquidity. Bid and ask budgets are distinct supplied model quantities; all same-side orders consume the same shrinking budget. Budgets do not carry forward. Every new unique tick is an explicit replenishment assumption. No queue-position, market impact or price improvement beyond the supplied quote is inferred.

Only ticks with `sourceTime == time` can provide liquidity. At equal decision and tick timestamps no fill occurs even if the sequence is later. Clock events can apply cancellations without price updates. A position never disappears when quotes end.

## Accounting and reporting

For a filled buy of `n` lots at `p` with fee `f` per lot, cash changes by `-n*p - n*f` and inventory by `+n`. A sale changes cash by `n*p - n*f` and inventory by `-n`. No separate slippage debit is applied. Fill IDs are deterministic market-event/order pairs. The host independently derives all postings from the Bend-produced filled-quantity deltas and reconciles them to the resulting ledger after every event.

Terminal equity is cash plus remaining lots times last bid, with no hypothetical exit fee. Mark age is checked against `maxQuoteAgeMs` when open inventory remains. A stale terminal mark produces a critical quality status and null terminal performance. A caught invalid-input or runtime error poisons normal reporting, including after checkpoint restore; start a new corrected run. Ordinary risk rejection is a modeled order outcome, not a corrupt run.

Net P&L is terminal equity minus initial cash; return is that P&L over initial cash as an exact numerator/denominator pair. External capital is unsupported. Drawdown starts from initial cash and samples equity at every accepted quote. Empty samples give null drawdown. Sharpe is explicitly undefined because no regular sampling or annualization convention is supplied. There is no claim that quote-sampled drawdown captures an unobserved intratick loss. Open losses are always included when a valid mark exists.

## Formal statements and limits

| Bend law | Quantified assertion | Status |
| --- | --- | --- |
| `buy_updates_ledger_exactly` | Starting cash equals exact cost plus spare; posting leaves spare cash and increases holdings exactly | Compiler checked |
| `sell_updates_ledger_exactly` | Sufficient holdings and price at least fee; posting credits exact net proceeds and debits exact lots | Compiler checked |
| `cancellation_is_idempotent` | Applying effective cancellation twice equals once for any order | Compiler checked |
| `cancellation_clears_working_quantity` | Cancellation moves all remaining lots to cancelled without touching filled quantity | Compiler checked |
| `accepted_submission_preserves_holdings` | The accepted admission branch appends the order and preserves the ledger | Compiler checked |
| `rejected_submission_preserves_state` | Rejected admission branch returns the exact state | Compiler checked |
| `liquidity_is_bounded` | The allocation primitive `min(requested, available)` never exceeds available | Compiler checked |
| `liquidity_partition_is_exact` | Allocated plus residual liquidity exactly equals available | Compiler checked |
| `partial_fill_updates_order_exactly` | With sufficient working quantity, a fill reduces working and increases filled by exactly the supplied lots | Compiler checked |
| `clock_replay_composes` | Replaying two lists of clock advances together equals replaying them in sequence | Compiler checked |

The admission law concerns its successful branch; it does **not** prove the risk predicate correct. The liquidity laws concern the allocation primitive; they do **not** prove the whole matcher correct. The replay law concerns clock advances; it does **not** prove JSON/checkpoint serialization. End-to-end admission, matching, causality, shared budgets, replay/checkpoint behavior, identity handling, numerical bounds and reporting are independently tested and checked at runtime. They are not advertised as universal end-to-end theorems. All ten statements also pass the extra `--verdict` check using the project-local Lean 4.34.0 kernel. That success does not verify the compiler translation, generated JavaScript, vendor data or economic model.

## Checkpoints and provenance

Checkpoints contain configuration, all accepted unique input events, failed-input audit records, source hashes and a checksum. Restoring replays the full prefix, reconstructing orders, outstanding cancel requests, reservations, duplicate detection, valuations and trace. This is exact and portable JSON, with O(history) restoration rather than a fast binary snapshot. Source mismatch or checksum mismatch rejects restore. No RNG state exists in the pure engine. Stateful strategy callbacks must persist their own state and are not part of these engine checkpoints.

Reports include dataset/config/source hashes, toolchain, runtime, strategy and protocol identifiers, assumptions, trace and a trace hash. The full dataset and generated report should be retained together. Supplied identifiers do not prove that external model training, universe construction or strategy selection was reproducible. Build hashes prevent accidental stale-check claims; they are not signatures against malicious editing.

## Research integrity boundary

`validateModelArtifact` binds the full supplied ordered feature schema, units and missingness policy to a hash; requires model/preprocessor content hashes and matching fold identity; checks label availability <= training start <= training completion <= deployment <= decision time through the Bend policy module. The caller must hash actual artifacts and supply truthful timestamps. The newer features/models modules add a shared streaming/batch implementation, training-only scaling and deterministic ridge/OLS; these numerical routines are tested, not part of the source proof boundary.

`EvaluationSession` fixes a protocol and strategy hash and rejects training/selection access to final partitions through Bend's role policy; final access is single-use within that session. The newer `withFinalHoldout` adds a persistent cross-process claim for a dataset plus holdout ID, consumed even on failure. Both remain cooperative helpers, not sandboxes against direct reads or another holdout identity. `gridJobs` provides validation-only parameter search; no reinforcement-learning reward layer is shipped.

`runExperiment` creates a unique on-disk record before executing work, then records completion or failure. An interrupted run remains `running` for audit. CLI trials additionally save raw-input hashes, full configuration and dataset hashes as soon as available. Every CLI run uses it; direct low-level API calls must be wrapped explicitly. The registry cannot attest to experiments conducted outside it.

## Shared policy additions

`bend/Policy.bend` is used directly by the strategy and ML adapters. Its laws require:

- Training and model selection cannot read final partitions; training cannot read validation, and the final role can read final data.
- Lot caps never exceed requested size, available capital lots or position headroom; a fully feasible request is preserved exactly.
- Labels available at/after cutoff are excluded; observations available at/after cutoff are excluded.

These extend the ten engine laws. They do not prove filesystem claims, arbitrary callback data access, numerical model quality or all orchestration code. Concurrency and artifact correctness are checked using real subprocess races, timeouts, crashes, recovery and tampering tests. See [RESEARCH.md](RESEARCH.md) for APIs and operational limits.

## Completed bars and optimized storage

The additional bar timing policy requires execution strictly after both the
supplied information-availability timestamp and next-open timestamp. Two laws
exclude unavailable/same-time inputs; a positive law requires ready bars to pass
after a positive delay. These specify timing, not the truth of vendor timestamps
or executable prices. The explicit cash-price proxy assumptions and integer
rounding rules are in [ETH_EXPERIMENTS.md](ETH_EXPERIMENTS.md).

Four compaction laws specify an empty working list, removal of zero-remaining
orders, retention of positive-remaining orders in FIFO order, and preservation
of the ledger. The host independently checks the returned compact state and
maintains completed-order records, including pending cancellation metadata.
This brings the project specification to 25 laws. Host archive handling and
equivalence of full replay remain E2E-tested properties, not whole-engine
theorems. Proof mutation tests require broken implementations to be rejected by
the relevant specification, including a predicate that prohibits every bar fill
and a filter that fabricates an order from an empty list.

`orderStorage: 'active'` is the default: only working orders enter Bend matching
and reservation scans; public final orders and the full state retain the audit
history. Explicit `orderStorage: 'all'` is a bounded reference mode for equivalence
tests, not long campaigns: historical-order scans can exceed the backend stack.
`traceMode: 'compact'` omits order arrays
from each trace sample and therefore intentionally changes the trace hash.
Comparisons use the same trace mode. Checkpoints record these options and still
replay all accepted events; they do not capture stateful bar-strategy models.
