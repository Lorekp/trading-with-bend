---
name: bend-research
description: Entry point for research and backtesting in trading-with-bend. Use to start an end-to-end study, understand the local framework or choose the specialist skills needed for a research task.
---

# Bend Research

Carry the requested research work through its relevant stages, loading the specialist guidance when that stage becomes necessary.

## Orient in the local framework

Resolve repository paths from the active `trading-with-bend` checkout, not this installed skill. Read `AGENTS.md`, `docs/RESEARCH.md` and `docs/CONTRACT.md`. Confirm current exports in `src/index.mjs` and nearby workers before writing code; the local implementation is authoritative over this 2026-10-03 knowledge snapshot.

The framework separates **information**, **decisions** and **execution**. An information source publishes observations; a strategy requests total target lots; a separately supplied venue owns fills, fees, account valuation and risk admission. Strategies return canonical lot strings or `null`. A requested target is intent, and actual holdings can lag it.

Cash quote/bar venues and the single-instrument derivative venue have different economic contracts. The ETH cash-price bar proxy is not a perpetual model. Linear/inverse derivatives, funding, margin, liquidation and expiry already exist. Use `docs/ADAPTERS.md` for interfaces and `docs/DERIVATIVES.md` for derivative units/economics.

Research evidence rests on causal availability, verified dataset/model identities, comparable controls and a complete trial population. Exact accounting and policy laws do not prove vendor data, arbitrary training code, execution realism or future profitability. `docs/MARKET_DATA.md` describes ingestion and timing; `docs/FORECASTING.md` describes sequence/model workflows.

## Route by the work

Read the linked specialist's `SKILL.md` and only its relevant supporting references before performing that work. These are sibling skills in both the installed set and the repository's `skills/` directory. If a sibling is missing, locate that named skill in the available catalog or the active checkout; report an unavailable dependency rather than guessing its instructions.

| Current work | Guidance to load | Expected result |
| --- | --- | --- |
| Form a hypothesis, choose controls/splits, bound a search or define rejection criteria | [bend-research-design](../bend-research-design/SKILL.md) | Falsifiable plan with discovery status and a bounded decision |
| Ingest/join/resample data, normalize units or investigate feature leakage | [bend-data-causality](../bend-data-causality/SKILL.md) | Admitted causal data/features with explicit provenance and assumptions |
| Implement signals, sizing, exits, warmup or choose an execution model | [bend-strategy-development](../bend-strategy-development/SKILL.md) | Local worker/strategy with explicit target and execution semantics |
| Fit/preprocess models, build labels, retrain or audit prediction availability | [bend-model-validation](../bend-model-validation/SKILL.md) | Verified training lineage and honestly timed evaluation/predictions |
| Register/run grids, retain artifacts, coordinate workers or recover failures | [bend-experiment-campaigns](../bend-experiment-campaigns/SKILL.md) | Immutable, attributable attempts with every status retained |
| Audit outcomes, compare candidates, assess robustness or describe an edge | [bend-backtest-analysis](../bend-backtest-analysis/SKILL.md) | Comparable evidence and a conclusion bounded by its assumptions |

A focused task can need one specialist. For mixed work, compose the relevant skills in dependency order: establish the research question and causal inputs, implement the rule or model, register/evaluate attempts, then interpret evidence. Load additional guidance when the work reaches it; routing is not a reason to stop at an outline or launch an unrequested campaign.

## Preserve the research boundary

Use existing toolkit modules before adding parallel implementations. Place study workers/helpers under `experiments/<study>/`, and retain identity-relevant code, data, seeds and assumptions in registered configuration/dependencies and immutable artifacts.

Train on the admitted training partition, select on validation, and keep failed/abandoned attempts visible. Comparisons use the same dataset and evaluation windows; changed execution assumptions remain labeled stress populations. Interpret results against controls and the declared objective, including open exposure and costs.

For official multi-agent studies, name one coordinator for the frozen specification, common inputs, total search/resource budget and complete report. Use `createCampaign().submit/seal/run/report`; load the campaign specialist before admission. Raw queues remain suitable for focused diagnostics. Count prior studies, manual changes and separate stress campaigns in the search history.

Freeze economic acceptance separately from raw-return ranking: capital/exposure, horizon, benchmark, costs, risk/capacity limits and rejection criteria. A numerical winner can yield "no acceptable strategy". The design and analysis specialists cover that decision and search-wide uncertainty.

Final evaluation of an official campaign uses `releaseCampaignFinal` with one absolute shared `finalAuthorityDirectory` across checkouts. The coordinator keeps final values out of explorer configuration, bundled helpers and input snapshots, and releases only the frozen official winner when requested. `withFinalHoldout` remains the lower-level helper. Failure consumes the release; further tuning needs genuinely untouched evidence, not a renamed claim.

For capability questions or proposed extensions, inspect current code and the relevant economic contract. Consult `docs/RESEARCH_SKILLS.md` for the original conceptual mappings and prioritized additions; verify that a listed gap still exists before proposing implementation.
