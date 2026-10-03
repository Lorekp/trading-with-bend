---
name: bend-backtest-analysis
description: Audit and interpret trading-with-bend backtest or study evidence, including artifact integrity, economic assumptions, exact returns, regular sampling, failure-preserving comparisons and limits of profitability claims. Use for reviewing results, choosing a validation candidate or evaluating robustness.
---

# Bend Backtest Analysis

Decide what the evidence supports before ranking strategies or describing an edge.

Paths refer to the target `trading-with-bend` repository. Read `AGENTS.md`, `docs/RESEARCH.md` and `docs/CONTRACT.md`; use `docs/DERIVATIVES.md` for derivative reports. Confirm current APIs instead of assuming vendor metric conventions. This skill adapts a 2026-10-03 knowledge snapshot.

For saved campaign outcomes, ledger/fill checks or invalid reports, read [evidence-audit.md](references/evidence-audit.md). Start with the official `campaign.report()` and use verified registry reads and complete replay audits. Keep every admission and attempt visible, including failed/abandoned/invalid work.

For comparisons, regular-return metrics or a research conclusion, read [metrics-and-conclusions.md](references/metrics-and-conclusions.md). Match information, execution, dataset, split, protocol and baseline identities before using `selectStudy`. Use `sampleEquity` and `regularReturns` only with explicit, valid sampling conventions.

Check open losses, mark freshness, fees, funding/margin where applicable, fill feasibility and whether the model was available at each decision. A positive result with an impossible fill or selected future information is not economic evidence.

Report the whole validation population, previous searches/manual changes, fold behavior, baseline improvement, stress assumptions and search-wide uncertainty. State economic acceptance separately from the official raw-return winner; a rejected winner means no acceptable strategy under the frozen rule. Separate held-out confirmation from exploratory selection and checked accounting from economic validity. Final data is consumed only for requested confirmation through the coordinator's release authority.
