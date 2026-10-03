# Research skills for the local backtesting framework

These skills distill QuantConnect's Writing Algorithms documentation into workflows for **trading-with-bend**. They use the local APIs and economic contracts; they do not introduce QuantConnect/LEAN dependencies or compatibility wrappers. The main influence is the research guide's emphasis on a hypothesis, bias control, out-of-sample evaluation and retaining evidence against an idea.

The source documentation was downloaded on 2026-10-03. Its official source snapshot is `fc50f126f5c47748e0667b898c9af4c7583da5e3`; see [the archived source identity](quantconnect-writing-algorithms/source-snapshot.json). Each skill's supporting references cite the relevant original pages and name the local source/documents used for the translation. New artifact shapes and falsification suggestions are identified as local adaptations.

## Entry point and specialist skills

Use **`$bend-research`** as the entry point. It provides general framework context and routes the current work to the relevant specialist skills, loading their guidance as needed. It covers mixed studies without requiring every specialist for a focused task. Its versioned source is [skills/bend-research/SKILL.md](../skills/bend-research/SKILL.md).

The six specialist skills remain directly invokable:

| Invoke | Use it for | Main local counterparts |
| --- | --- | --- |
| `$bend-research-design` | Hypothesis/discovery status, alternatives, research budget, controls and rejection criteria | `walkForwardSplits`, `evaluateStudy`, `gridJobs`, `selectStudy`, `withFinalHoldout` |
| `$bend-data-causality` | Ingestion, units, publication delays, as-of joins, gaps and causal features | `openMarketSource`, `prepareMarketData`, `asOfMarketData`, `RollingFeatures`, prepared sources |
| `$bend-strategy-development` | Rule signals, sizing, warmup, exits and execution-model selection | `runStrategy`, `runBarStrategy`, target strings, source/venue contracts and existing strategy factories |
| `$bend-experiment-campaigns` | Registered workers/grids, dependencies, parallel capacity, immutable artifacts and recovery | `gridJobs`, `enqueueExperiment`, `runQueue`, `runExperiment`, verified registry readers |
| `$bend-model-validation` | Training-only preprocessing, mature labels, fold lineage, deployment timing and forecast evaluation | `foldRows`, `fitStandardScaler`, `fitRidge`, `fitForecast`, checked prediction/evaluation APIs |
| `$bend-backtest-analysis` | Evidence audit, comparable populations, exact economics, regular metrics and narrow conclusions | `readReplayAudit`, artifact verification, `sampleEquity`, `regularReturns`, `selectStudy` |

Versioned sources live in `skills/bend-*/`; installed copies use the same self-contained `SKILL.md`, UI metadata and conditional references. Repository paths inside the skills are resolved from the active framework checkout, so they do not depend on this particular Windows worktree path. Normal automatic discovery remains enabled. Using a skill does not launch a campaign, consume final data, or authorize unrelated external actions.

The repository's `AGENTS.md` points research/backtesting work to the entry skill, so agents in T3 Code can reach the versioned guidance directly. All seven skills are also installed in this environment's Codex skills directory and appear in the current T3 Code skill catalog; invoke `$bend-research` to start.

For example: “Use `$bend-research` to take this mean-reversion idea through a local validation study.” For focused work: “Use `$bend-research-design` to design a falsifiable test using our Binance information and separately supplied execution data,” or “Use `$bend-backtest-analysis` to review this registered campaign and decide what its validation evidence supports.”

## Important translations

| Advice or concept from the original docs | Local translation and semantic difference |
| --- | --- |
| Initialize an algorithm and consume data events | A worker constructs independent source/venue/strategy instances; `runStrategy` invokes a target callback |
| Historical data and rolling indicators | Verified loaders/prepared sources plus `RollingFeatures` and bounded information history; local history is oldest-to-newest |
| Warm indicators before trading | `evaluateStudy` provides history-only warmup and suppresses strategy calls before validation; mutable callback state needs explicit initialization |
| Set desired holdings and track order events | Return total lot strings; read actual venue holdings/working orders and audit fills; a signal is not a fill |
| Configure fill, fee and buying-power models | Use the selected `ExecutionVenue` and its documented contracts; source data never silently determines execution prices/liquidity |
| Train and schedule model updates | Verified training artifacts, explicit cutoff/deployment times, worker preparation or local walk-forward ridge logic |
| Store model/research evidence | Immutable attempt artifacts and content inventories, not mutable organization-wide storage keys |
| Walk-forward optimization and final testing | Purged chronological splits, all-fold validation and one persistent final release |
| Compare performance statistics | Exact monetary results plus explicitly regular numerical metrics; independent-fold returns do not form a compounded equity curve |
| Paper/live reconciliation | A useful future validation layer; current adapters are synchronous replay, not live transports |

## What the framework already has

The current framework already supplies verified data/artifact identities, label purging and embargo, training-only standardization, simple numerical model baselines, sequence forecasts, immutable experiment populations, persistent final-release claims, causal source/venue separation, complete disk audits, bounded history and explicit sampling. It also has **linear/inverse derivatives, funding, margin, liquidation and expiry** through `DerivativeExecutionVenue`. Those are not missing features. The ETH bar campaign remains a separately declared cash-price proxy.

Likewise, basic causal feature checks and ledger/fill checks already exist in the test/audit workflows. The useful additions below concern reusable research behavior, diagnostics and economic coverage, rather than replacing those checks.

## Recommended implementation additions

These are recommendations, not changes made by this task. Priorities assume the current single-instrument crypto research use case.

### 1. A small, versioned research-plan contract

The registry fixes executable inputs; it does not require a thesis, competing explanation, search rationale, primary objective or falsifier. Add a small validated research-plan artifact containing those fields and a declared discovery/confirmation status. Hash it into job configuration and preserve it with `context.writeArtifact`. Keep it separate from `evaluateStudy.protocol`, whose accepted keys are deliberately narrow.

This would make agents' thesis changes and budget decisions reviewable. It cannot prove a hypothesis was devised without seeing prior results or discover studies conducted outside the registry. A useful first acceptance check is rejection of conflicting plan identity under an existing job, plus a report connecting every candidate/stress variant to the plan.

Basis: [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), `src/experiments.mjs`, `src/search.mjs`, `src/study.mjs`.

### 2. A reusable robustness-study summary

Existing grids and the ETH campaign can already vary costs and parameters. What is missing as a shared research interface is a summary of neighboring-parameter stability, signal ablations, fold/regime contributions, and break-even cost/delay/liquidity assumptions. Build that orchestration on existing jobs and audits, retaining separate execution identities for stress populations. Do not relax `selectStudy`'s comparable-identity checks to fit stress results into one ranking.

Report the edge relative to controls over the declared scenario range, including failures and isolated optima. Acceptance should show that mixed execution models remain labeled as separate populations and that omitted/failed cells remain visible. This is especially useful before expanding model complexity.

Basis: [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), [Walk Forward Optimization](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization), `src/search.mjs`, `src/study.mjs`, `experiments/eth/worker.mjs`.

### 3. Trading-return uncertainty and selection diagnostics

The shared study API computes ordinary Sharpe and exact validation-return ranking, not confidence intervals, probabilistic Sharpe or selection-adjusted significance. The bootstrap in `experiments/speed/statistics.mjs` measures engine performance and does not supply a strategy-return inference method.

Add a separately documented numerical analysis layer over regular returns, with explicit dependence assumptions, baseline excess-return uncertainty and the recorded candidate population. QuantConnect documents probabilistic Sharpe; correction for searching many candidates is an additional problem and should be treated separately. Reuse suitable established numerical utilities and verify formulas against primary statistical references before implementation. Analytic cases, correlated-return fixtures and deliberate winner selection are meaningful validation cases.

Basis: [Glossary — Probabilistic Sharpe](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/glossary#25-Probabilistic-Sharpe-ratio), `src/evaluation.mjs`, `src/study.mjs`.

### 4. Empirical execution calibration and later paper-fill reconciliation

Fees, spread, latency, funding and margin are already modeled. Queue position, persistent book depletion, market impact and exchange-specific liquidation auctions are not established by the supplied BBO/bar proxies. A valuable next layer is recording calibration data and assumptions from observed execution/receipt times, then measuring model-versus-observed fill/fee/delay deviations. A paper/live adapter would additionally need order acknowledgments, reconnect behavior, state recovery and duplicate handling; those are not provided by the synchronous replay contract.

Keep any new calibrated venue behind `ExecutionVenue`, and retain the existing reference venue and its laws. Validate on withheld execution records; historical displayed depth alone cannot certify fillability. Prioritize this when the claimed edge or capacity is comparable to assumed trading frictions.

Basis: [Trade Fills](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/trade-fills/key-concepts), [Reconciliation](https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading/reconciliation), `docs/ADAPTERS.md`, `docs/DERIVATIVES.md`, `docs/MARKET_DATA.md`.

### 5. Reusable causal consolidation/indicator lifecycle, when duplication appears

The code already has trailing features, Binance completed-bar aggregation and strategy-specific moving-average/ATR/channel logic. A generic calendar/session-aware consolidator and broader composable indicator lifecycle are not exposed by the public toolkit. Add them only when studies actually need repeated multi-frequency logic. Specify input/output type, interval/session boundaries, publication time, gap handling, readiness and exactly one update path.

Acceptance should cover streaming/batch parity, prefix causality, boundary timing and warmup without duplicated observations. A large catalog of indicators is less valuable than getting that shared timing seam correct.

Basis: [Consolidating Data](https://www.quantconnect.com/docs/v2/writing-algorithms/consolidating-data/getting-started), [Manual Indicators](https://www.quantconnect.com/docs/v2/writing-algorithms/indicators/manual-indicators), `src/features.mjs`, `src/binance-bars.mjs`, `src/bar-strategies.mjs`.

### 6. Historical universes and multi-asset accounting, only if the research scope expands

Current sources/venues declare one canonical instrument; there is no general point-in-time universe, corporate-action ledger, portfolio-wide multi-asset margin or automatic futures roll. These become necessary for cross-sectional equity research or shared-collateral portfolio studies. Independent per-instrument backtests do not reproduce correlated portfolio risk/margin or historical membership.

Treat this as a separate typed accounting/data design with new events and laws where required. Do not approximate it by relabeling instruments, scaling a single account or applying today's constituents to historical data. It is a larger extension than the current research-skill work and is not needed for every single-contract study.

Basis: [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), [Universes](https://www.quantconnect.com/docs/v2/writing-algorithms/universes/key-concepts), `docs/CONTRACT.md`, `docs/ADAPTERS.md`, `docs/DERIVATIVES.md`.

## Validation scope

All seven skill entrypoints and linked references passed Skill Creator's validator and local path validation; the entry skill's routing links resolve to all six specialists. Two independent behavioral forward tests covered realistic research and cross-venue strategy/model requests with the specialist skills. A small build-independent callback/runner check also passed. Demonstrated ambiguities about warmup venue coverage, quote-versus-bar helpers, cooldown counting and sequence timing were clarified. No campaigns ran, final data was not consumed and shared framework code was unchanged. These checks validate operational reasoning and callback plumbing, not trading profitability. Automatic skill discovery remains enabled; it may require a fresh Codex session to load newly installed skills.
