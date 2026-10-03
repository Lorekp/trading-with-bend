---
name: bend-backtest-analysis
description: Audit and interpret trading-with-bend backtest or study evidence, including artifact integrity, economic assumptions, exact returns, regular sampling, failure-preserving comparisons and limits of profitability claims. Use for reviewing results, choosing a validation candidate or evaluating robustness.
---

# Bend Backtest Analysis

Decide what the evidence supports before ranking strategies or describing an edge.

Paths refer to the target `trading-with-bend` repository. Read `AGENTS.md`, `docs/RESEARCH.md` and `docs/CONTRACT.md`; use `docs/DERIVATIVES.md` for derivative reports. Confirm current APIs instead of assuming vendor metric conventions. This skill adapts a 2026-10-03 knowledge snapshot.

For saved campaign outcomes, ledger/fill checks or invalid reports, read [evidence-audit.md](references/evidence-audit.md). Use `listExperiments`, `readExperimentResult`, `verifyExperimentArtifacts` and complete replay audits. Keep failed/abandoned/invalid cases visible.

For comparisons, regular-return metrics or a research conclusion, read [metrics-and-conclusions.md](references/metrics-and-conclusions.md). Match information, execution, dataset, split, protocol and baseline identities before using `selectStudy`. Use `sampleEquity` and `regularReturns` only with explicit, valid sampling conventions.

Check open losses, mark freshness, fees, funding/margin where applicable, fill feasibility and whether the model was available at each decision. A positive result with an impossible fill or selected future information is not economic evidence.

Report the whole validation population and fold behavior, chosen objective, baseline improvement, stress assumptions and uncertainty/limitations. Separate held-out confirmation from exploratory selection, forecast error from trading profit, and checked accounting laws from the economic truth of a model. Do not consume final rows merely to make a report look complete.
