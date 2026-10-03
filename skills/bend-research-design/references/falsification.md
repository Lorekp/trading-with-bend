# Parameter search, robustness and stopping

## Prefer an interpretable region to a lucky point

Choose ranges from the horizon/mechanism and available training population. Start with the simplest signal that tests the idea and a bounded coarse grid. A winning isolated setting surrounded by failures needs more skepticism than a broadly stable region; adding degrees of freedom after inspecting the curve increases the selection burden.

Use `gridJobs({ namespace, workerModule, baseConfiguration, space, dependencies, maxTrials })`. It creates deterministic configuration keys and permits automated search only on validation. Its key hashes configuration and seed, not the complete worker's source: version the study namespace when code, data or assumptions change. The registry separately pins source/dependencies and rejects identity drift.

Re-use the same split plan, dataset snapshot/seed, evaluation windows and baselines across candidate comparisons. Preserve failed, abandoned and invalid candidates. Save the number of explored variants, including earlier studies and manual idea changes when known. A grid's `maxTrials` bounds that grid; it does not measure every research decision ever made.

## Useful falsifiers

Select checks that can distinguish the hypothesized edge from a realistic alternative:

- Remove the proposed signal or replace it with cash/hold; establish that its improvement survives comparable execution.
- Perturb neighboring parameter values, decision/publication delays, plausible fees, liquidity participation and order/cancel latency.
- Inspect every validation fold and the contribution of extreme periods/trades. Record exclusions as variants instead of deleting inconvenient observations.
- Test another period or venue only when comparable data and units exist. Another routing ID is not another market, and reusing the same price series is not venue-transfer evidence.
- Check prefix causality: appending/changing future information must leave earlier features/signals unchanged. Alter future labels to check that earlier fitted/deployed predictions are unaffected.

Separate candidate selection from execution stress tests. `selectStudy` requires compatible data/plan/protocol/execution comparison identities. A higher-fee venue has a different identity and belongs in a labeled stress population, not silently in the same ranking table.

## Stop with a decision

Predeclare a reasonable trial/time budget and an outcome that changes the next action. If all configurations lose to the controls or rely on impossible fills, report the rejection and the evidence. A failed thesis is a useful result. A targeted fix to a demonstrated implementation bug is appropriate; altering the hypothesis to rescue the same validation curve starts a new exploratory variant.

`selectStudy` chooses exact aggregate validation return with trial-ID tie breaking. If a different objective is requested, compute and record it explicitly over the same complete validation population; do not describe the built-in selector as supporting that objective. Include risk/turnover diagnostics rather than inventing a universal profitability threshold.

Release final rows through the existing `withFinalHoldout` claim after freezing the selected strategy/protocol. Do not rename a holdout or dataset identity to repeat the same observations. Genuinely new, untouched observations can support a new registered confirmation study; record their provenance and freeze its protocol before release. After inspection, that evidence is no longer untouched for subsequent tuning. The gate is cooperative: callbacks and direct file reads can still leak data.

## Basis

Local: `src/search.mjs`, `src/study.mjs`, `src/evaluation.mjs`, `src/experiments.mjs`, `docs/RESEARCH.md`.

Distilled from [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), [Walk Forward Optimization](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization) and [Behavioral Finance](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/behavioral-finance). The falsification checklist is an adaptation, not a claim that local tooling implements statistical multiple-testing correction.
