---
name: bend-model-validation
description: Fit and evaluate trading models in trading-with-bend using causal feature artifacts, purged splits, training-only preprocessing and deployment-aware predictions. Use for ridge/OLS, sequence forecasts, external estimators or ML leakage and model-lineage audits.
---

# Bend Model Validation

Keep fitted state and predictions bound to the data, fold and earliest time they could exist.

Resolve paths from the target `trading-with-bend` checkout. Read `AGENTS.md`, `docs/RESEARCH.md`, and `docs/FORECASTING.md` for sequence/Python models. Confirm current `src/index.mjs` and estimator interfaces; this skill adapts a 2026-10-03 knowledge snapshot.

For features, labels, scalers, ridge or external model adapters, read [training-lineage.md](references/training-lineage.md). Start from the existing simple baseline before adding model complexity. Fit using the verified artifact returned by `foldRows(samples, plan, foldId, 'train', 'train')`; use validation for selection, not preprocessing fitting.

For sequences, early stopping, retraining timing or forecast evaluation, read [forecast-availability.md](references/forecast-availability.md). Verify the full feature/schema/target contract and distinguish retrospective validation diagnostics from predictions executable at those timestamps.

Save model, preprocessing, per-fold diagnostics and actual runtime identity through the experiment registry. For an official campaign, use the campaign specialist's frozen inputs and admission guidance; Python/foreign trainers require a declared trusted-worker campaign. Model hash and shapes alone do not establish correctness or availability. Keep final values with the coordinator even when the trainer has ordinary filesystem access.

Official campaign final rows are released through `releaseCampaignFinal` after selection/protocol freeze, using the shared final authority; `withFinalHoldout` remains the lower-level helper. Forecast error, calibrated fills, net profitability and formal policy proof are different claims: report only what the requested evaluation actually demonstrates.
