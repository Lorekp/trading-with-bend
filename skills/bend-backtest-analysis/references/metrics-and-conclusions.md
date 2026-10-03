# Comparable metrics and appropriately narrow conclusions

## Compare like with like

`evaluateStudy` evaluates candidate plus named baselines on every validation fold using fresh accounts and the same information/execution identities. It retains exact aggregate baseline excess returns and per-fold metrics. It sums independent-fold P&L and divides by summed initial capital; it neither compounds those folds nor splices their reset equity curves.

`selectStudy([{ id, status, study, error }])` retains failed/abandoned/invalid trials, rejects incompatible data/plan/protocol/execution identities and ranks exact aggregate validation return, with trial-ID tie breaking. A higher-cost venue stress study or another market needs a separate labeled comparison population. Final results are not a new tuning/ranking population.

Use `comparisonTable` for report-level population summaries; it preserves invalid results with null performance. The numerical selector does not account for drawdown appetite, statistical uncertainty, multiplicity or economic capacity. When the user's criterion differs from exact validation return, report that criterion explicitly without pretending it is an option to `selectStudy`.

## Sampling comes before Sharpe

Raw event-sampled reports deliberately do not infer annualized Sharpe. `sampleEquity(report, { startTime, endTime, intervalMs, maxStalenessMs })` uses the last available valuation at/before each grid point, with no future mark or interpolation. The endpoints must lie on the declared grid; missing/stale marks, unmarked/nonpositive equity and deficit accounts cause rejection.

`regularReturns(report, { intervalMs, periodsPerYear })` expects already regular valuations and never silently resamples them. Its arithmetic returns use sample standard deviation and zero risk-free rate, exclude the unsampled initial-to-first-quote period, and leave empty/constant series undefined. Choose annual frequency for the actual trading/sampling calendar rather than copying 252 days into a 24/7 minute market.

`evaluateStudy` computes equivalent fold summaries with streaming Welford accumulation, retaining count/hash rather than all return arrays. Small numerical differences from the two-pass helper can occur. Keep numerical and exact-money boundaries separate: monetary P&L/return ratios are strings/rationals; model and Sharpe values are floating point, not formally proved. Do not average fold Sharpes to obtain a supposed study Sharpe.

## Evidence for a strategy claim

Discuss all folds and regimes covered, edge relative to controls, exposure/turnover/fill counts, drawdown and the sensitivity to plausible costs/delays/liquidity. A short positive month, an isolated optimum or a few favorable trades does not establish robustness. Report uncertainty as unresolved when no suitable statistical analysis was performed; a deterministic seed is reproducibility, not confidence.

The shared trading-study API has no built-in probabilistic/selection-adjusted Sharpe or strategy-return confidence interval. Existing bootstrap code in the speed benchmark measures implementation performance, not trading returns. If uncertainty analysis is requested, use a separately justified method respecting serial dependence and candidate selection; retain the assumptions and whole trial population. Do not label ordinary Sharpe as a probability of future profit.

Distinguish development fixtures, exploratory validation, released final evaluation and calibrated paper/live execution. The local framework is synchronous replay and has no live transport/reconciliation implementation. Its proof contract covers specified arithmetic/policy laws, not arbitrary host code, external estimators, vendor data, queue realism or future profitability.

## Basis

Local: `docs/RESEARCH.md`, `docs/CONTRACT.md`, `docs/DERIVATIVES.md`, `src/study.mjs`, `src/evaluation.mjs`.

Distilled from [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), [Glossary](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/glossary), [Algorithm Statistics](https://www.quantconnect.com/docs/v2/writing-algorithms/statistics/algorithm-statistics) and [Reconciliation](https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading/reconciliation). Uncertainty recommendations are an adaptation; they do not claim a missing local feature is implemented.
