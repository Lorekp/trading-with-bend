# Designing a study that can reject an idea

## Mechanism before parameters

Describe the chain from an observable market condition to a predictable outcome, then from that outcome to executable net P&L. A plausible behavioral story is a source of predictions, not proof that a particular venue, horizon or instrument exhibits them. For example, mean reversion should predict an effect after deviations, not merely a profitable parameter on one month of prices.

Write down the alternative: market drift, spread capture that cannot actually be filled, stale prices, a few outliers, selecting a favorable instrument, or a regime shared by all validation folds. Identify the cheapest comparison that distinguishes it. Cash and buy-and-hold help separate exposure from timing; an entry/exit ablation helps isolate the claimed signal. Use a no-change/zero forecast baseline for a prediction study. Randomized controls can be useful when their design preserves the relevant time dependence; a generic shuffle is not automatically a valid null model.

Keep the discovery/confirmation distinction visible. After exploratory feature selection or parameter tuning, validation measures the selection process's performance, not independent confirmation of its winner. A new narrative after disappointing results is another research choice and belongs in the trial history.

## Local protocol

Record these fields in an immutable `context.writeArtifact('research-plan.json', plan)` artifact and put identity-relevant inputs in the job configuration:

| Field | Decision it fixes |
| --- | --- |
| Hypothesis or exploratory question | Mechanism, expected direction/horizon and competing explanation |
| Population | Instruments/venues, periods, exclusions and why those were chosen |
| Information timing | Observation, publication, revision, label maturity and deployment timing |
| Split | `walkForwardSplits` options, purge/embargo rationale and `finalStart` |
| Execution | Venue, units, fees, spread/liquidity/latency, funding/margin where applicable |
| Controls | Cash/hold or zero/ridge baselines, ablations and robustness scenarios |
| Objective and budget | Primary validation objective, candidate count and stopping rule |
| Falsifier | Evidence that would invalidate or materially weaken the thesis |
| Final-release policy | Strategy/protocol freeze and existing holdout identity |

This is an authored research-plan artifact, not a new framework schema. `evaluateStudy` accepts only its existing protocol keys: `warmup`, `account`, `intervalMs`, `periodsPerYear`, `maxStalenessMs`. Keep hypothesis metadata separate; adding extra protocol keys causes rejection.

Use `evaluateStudy({ samples, plan, protocol }, prepareFold)` for all-fold validation. Its callback receives verified training and validation artifacts. Supply a fresh strategy and a fresh `createReplay({ variant })` account for each variant and fold, with identical information, execution, instrument and model identities. Warmup is history-only and accounts reset per fold. Results describe independent windows, not a continuous compounded deployment.

## Bias belongs upstream as well as in the split

Chronological splitting cannot repair choosing an instrument because its full-period return looked attractive, revised fundamentals labeled with the reporting period, or current index constituents applied to the past. Record point-in-time population membership and publication lags where relevant. The current single-instrument framework has no general historical-universe service; make any population construction explicit in datasets and dependencies.

A reporting lag is an assumption with a source and sensitivity range. It is not a substitute for missing release history. Preserve raw extremes; transformations such as clipping, ranking or normalization are research choices fitted on permitted training data and frozen for evaluation.

## Basis

Local: `docs/RESEARCH.md`, `docs/ADAPTERS.md`, `src/evaluation.mjs`, `src/study.mjs`, `src/search.mjs`.

Distilled from QuantConnect's [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide) and [Behavioral Finance](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/behavioral-finance), downloaded 2026-10-03. The artifact shape and local API mapping above are adaptations for this repository.
