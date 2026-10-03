---
name: bend-strategy-development
description: Implement rule-based trading strategies in trading-with-bend using target positions, causal bounded history and independent information/execution adapters. Use for new signals, sizing, exits or translating trading examples into this local framework; model fitting has a separate workflow.
---

# Bend Strategy Development

Express the trading decision as desired total exposure and let the selected local venue own execution.

Resolve code/document paths from the target `trading-with-bend` repository. Read `AGENTS.md`, `docs/ADAPTERS.md` and `src/adapter-contracts.d.ts`; confirm current exports and nearby workers. This skill uses a 2026-10-03 knowledge snapshot, not a vendor API compatibility layer.

For callback shape, signal state, warmup or position sizing, read [target-position-workflow.md](references/target-position-workflow.md). Reuse `targetPosition`, `buyAndHold`, `movingAverageCrossover`, `meanReversion`, `createBarStrategy` and `RollingFeatures` where their semantics fit. Put new study workers/helpers under `experiments/<study>/`.

For fills, exits, costs, cash versus perpetuals or checkpoint continuation, read [execution-models.md](references/execution-models.md). Compose `runStrategy(source, venue, strategy)` or `runBarStrategy` with explicitly supplied independent datasets. Callbacks return canonical target lot strings or `null`, never raw submit/cancel arrays.

Use fresh strategy and venue instances for each replay. Read actual holdings and working orders rather than assuming a signal filled. Keep money/quantity arithmetic exact and source-derived features separate from venue valuation.

Validate a small end-to-end registered run against cash/hold controls before scaling. For strategy changes, exercise realistic warmup, missing/stale information and delayed/partial execution paths. Changes to shared execution/research modules require the repository's `npm test` and applicable `npm run test:regression`; a new skill or prose edit does not.

Deliver the implemented worker and recorded assumptions/results. Describe unsupported behavior as a capability gap instead of approximating it invisibly or claiming an observed market fill.
