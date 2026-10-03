# Establish that the result is usable evidence

## Verify identities and the complete population

Use the registry's `listExperiments`, `readExperimentResult(root, key)` and `verifyExperimentArtifacts(root, key)` instead of trusting an exported best-result file. Preserve status/error and retried/abandoned attempts. Results, models and audit references must match their inventories and the study's actual input/build/dependency identity.

For disk reports, `readReplayAudit(report.audit, 'fills')` and the corresponding postings/orders/valuations expose complete retained streams without full materialization. Keep the manifest and database/shards at their referenced paths. A detached summary or disk checkpoint descriptor is not the complete evidence package. Prefer the existing `scripts/audit-eth-campaign.mjs` for the ETH campaign whose artifact schema it supports; do not assume that specific script audits every arbitrary worker.

Check `status`, quality failures and poisoned invalid input before treating performance fields as valid. An ordinary risk rejection is an economic outcome; a malformed dataset/runtime reconciliation failure invalidates the run. Stale or unmarked inventory cannot silently become a zero loss. Snapshot/quote checksums certify content identity, not vendor truth or completeness.

## Reconstruct the economics appropriate to the venue

Cash: each filled lot posts exact purchase/sale price and its configured per-lot fee. Working buy/sell quantities reserve cash/inventory and share supplied per-side fill budgets. Fill time is strictly after decision and at/after arrival. Cancellation is not immediately effective when configured latency is positive. Source prices never supply missing venue quotes/marks.

Derivatives: reconcile `cash = initialCash + realizedPnl + funding - fees` and `equity = cash + unrealizedPnl`, including FIFO slice/rounding, funding signs, liquidation charges/deficits and expiry settlement. Compare in the same settlement currency and contract definition. A deficit account cannot become an ordinary positive-equity Sharpe sample.

Bar proxy: inspect next eligible execution timing, assumed spread, previous completed-volume budget and collar. A completed-bar exit is not an intrabar stop order. Market impact, queue priority and displayed-volume replenishment are declared modeling limits; repeat that limit where a strategy's claimed capacity depends on it.

## Model availability and source causality

Inspect feature definitions/availability, label maturity, preprocessing fit population, training/deployment timestamps and actual artifact hashes. Prefix-causal feature code does not prove that a foreign trainer avoided final rows. Retrospective forecasts selected with validation labels cannot be replayed as if their selected weights already existed.

The venue's marked open position remains in terminal P&L. It need not have a completed round trip. Do not compare closed-trade profit with account equity while ignoring open losses, or impose an unrequested hypothetical liquidation fee.

## Basis

Local: `docs/CONTRACT.md`, `docs/DERIVATIVES.md`, `docs/ADAPTERS.md`, `src/experiments.mjs`, `src/recording.mjs`, `scripts/audit-eth-campaign.mjs`.

Distilled from [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), [Trade Fills](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/trade-fills/key-concepts), [Reconciliation](https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading/reconciliation) and [Trade Statistics](https://www.quantconnect.com/docs/v2/writing-algorithms/statistics/trade-statistics).
