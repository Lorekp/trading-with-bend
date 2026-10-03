# Parameter search, robustness and stopping

## Prefer an interpretable region to a lucky point

Choose ranges from the horizon/mechanism and available training population. Start with the simplest signal that tests the idea and a bounded coarse grid. A winning isolated setting surrounded by failures needs more skepticism than a broadly stable region; adding degrees of freedom after inspecting the curve increases the selection burden.

Use `gridJobs({ namespace, workerModule, baseConfiguration, space, dependencies, maxTrials })`. It creates deterministic configuration keys and permits automated search only on validation. Its key hashes configuration and seed, not the complete worker's source: version the study namespace when code, data or assumptions change. The registry separately pins source/dependencies and rejects identity drift.

For official multi-agent work, submit those jobs through `createCampaign`; the coordinator freezes aggregate allocation before admission, including ablations, stress populations and any deterministic rule for choosing stress representatives. `gridJobs` and individual campaign limits cannot enforce the cross-campaign total. Failed admitted jobs consume budget; recovery retains their history.

Re-use the same split plan, dataset snapshot/seed, evaluation windows and baselines across candidate comparisons. Preserve failed, abandoned and invalid candidates. Save the number of explored variants, including earlier studies and manual idea changes when known. A grid's `maxTrials` bounds that grid; it does not measure every research decision ever made.

Inventory earlier data exposure before calling a period untouched. Keep known and unknown prior searches explicit. Before observing winners, choose the dependence-aware uncertainty/selection diagnostic and preserve regular paired returns, folds and candidate identities needed to apply it. A deflated/probabilistic Sharpe formula does not repair unknown search breadth, dependent returns or unrealistic execution; ordinary Sharpe is not a probability of profit.

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

`selectStudy` chooses exact aggregate validation return with trial-ID tie breaking. Official campaigns freeze that ranking and bind final release to its winner. Apply the predeclared economic accept/reject rule separately. If the winner fails benchmark, risk, costs or capacity requirements, finish with no acceptable strategy. An auxiliary ranking can be reported as such; post-results filtering or substitution cannot change the official winner. Supporting another official objective requires extending/testing the selection contract before admission.

For official campaigns, fix one absolute `finalAuthorityDirectory` shared across checkouts; the coordinator owns final values and calls `releaseCampaignFinal(campaign, { samples, plan }, callback)` only for requested confirmation after sealed terminal completion and strategy/protocol freeze. The helper verifies the persistent official winner and selected artifacts, derives the claim from dataset/final rows and consumes it even if the callback fails. `withFinalHoldout` remains the lower-level gate. Another name, training-fold plan or authority cannot honestly make the same observations untouched again.

Prepare exploration-only values before submission: inspect configuration, helper files, input snapshots and any full sample arrays for embedded final observations. Filesystem isolation denies undeclared reads but does not discover hidden final values in permitted files; trusted workers have ordinary access. Keep dataset/plan identity compatible with final release, which requires the original frozen samples/plan. Read the campaign specialist's input guidance for metadata-only plans or verified partition handling.

Genuinely new untouched observations can support a registered confirmation study with provenance and a protocol frozen before release. After inspection they are exploratory for later tuning. If prior exposure is uncertain, freeze the protocol and collect future confirmation evidence. Authority and role gates remain cooperative, not proof against deliberate leakage.

## Basis

Local: `src/search.mjs`, `src/study.mjs`, `src/evaluation.mjs`, `src/campaigns.mjs`, `src/campaign-final.mjs`, `src/experiments.mjs`, `docs/RESEARCH.md`.

Distilled from [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), [Walk Forward Optimization](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization) and [Behavioral Finance](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/behavioral-finance). The falsification checklist is an adaptation, not a claim that local tooling implements statistical multiple-testing correction.
