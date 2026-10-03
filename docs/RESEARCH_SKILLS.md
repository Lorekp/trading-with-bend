# Research skills for the local backtesting framework

These skills distill QuantConnect's Writing Algorithms documentation into workflows for **trading-with-bend**. They use the local APIs and economic contracts; they do not introduce QuantConnect/LEAN dependencies or compatibility wrappers. The main influence is the research guide's emphasis on a hypothesis, bias control, out-of-sample evaluation and retaining evidence against an idea.

The source documentation was downloaded on 2026-10-03. Its official source snapshot is `fc50f126f5c47748e0667b898c9af4c7583da5e3`; see [the archived source identity](quantconnect-writing-algorithms/source-snapshot.json). Each skill's supporting references cite the relevant original pages and name the local source/documents used for the translation. New artifact shapes and falsification suggestions are identified as local adaptations.

## Entry point and specialist skills

Use **`$bend-research`** as the entry point. It provides general framework context and routes the current work to the relevant specialist skills, loading their guidance as needed. It covers mixed studies without requiring every specialist for a focused task. Its versioned source is [skills/bend-research/SKILL.md](../skills/bend-research/SKILL.md).

The six specialist skills remain directly invokable:

| Invoke | Use it for | Main local counterparts |
| --- | --- | --- |
| `$bend-research-design` | Hypothesis/discovery status, economic acceptance, search-wide uncertainty, controls and rejection criteria | `walkForwardSplits`, `evaluateStudy`, `createCampaign`, `selectStudy`, `releaseCampaignFinal` |
| `$bend-data-causality` | Ingestion, units, publication delays, as-of joins, gaps and causal features | `openMarketSource`, `prepareMarketData`, `asOfMarketData`, `RollingFeatures`, prepared sources |
| `$bend-strategy-development` | Rule signals, sizing, warmup, exits and execution-model selection | `runStrategy`, `runBarStrategy`, target strings, source/venue contracts and existing strategy factories |
| `$bend-experiment-campaigns` | Official populations, frozen workers/inputs, shared admission, artifacts and recovery | `createCampaign`, `releaseCampaignFinal`, `gridJobs`, `queueStatus`, `recoverQueue`, verified registry readers |
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

Official multi-agent studies use `createCampaign().submit/seal/run/report` with one coordinator owning the specification, common inputs, total trial allocation and host resources. Admission freezes verified toolkit/build files, installed locked package bytes, declared helpers and `inputFiles` snapshots. Shared runners use one absolute `admissionRoot` with identical budgets; per-runner concurrency is only a local limit. Sealed terminal membership and verified complete studies produce the immutable official selection.

The coordinator keeps final values out of exploration configuration, helpers and snapshots. Official final evaluation uses `releaseCampaignFinal` with one absolute shared `finalAuthorityDirectory` across checkouts; `withFinalHoldout` remains the lower-level helper. Filesystem isolation reduces accidental reads but cannot identify final values embedded in permitted inputs. Safe payload preparation must preserve sample/plan identity: final release requires the original frozen hashes, so slicing a full sample array is not a substitute for a compatible input design.

Official selection ranks exact aggregate validation return. Research plans now require a separate economic acceptance rule with common capital/exposure, holding horizon, benchmark, costs, risk limits and capacity assumptions. A winner failing that rule yields no acceptable strategy; another candidate cannot be substituted after results. Profitability-seeking swarms also inventory searches across agents/studies and predeclare dependence-aware uncertainty analysis over retained regular paired returns. This guidance does not implement a new selector or statistical inference layer.

Likewise, basic causal feature checks and ledger/fill checks already exist in the test/audit workflows. The useful additions below concern reusable research behavior, diagnostics and economic coverage, rather than replacing those checks.

## Recommended implementation additions

These are recommendations, not changes made by this task. Priorities assume the current single-instrument crypto research use case.

### 1. A recorded research plan, with a validated contract if later needed

The registry fixes executable inputs; it does not require a thesis, competing explanation, search rationale or falsifier. For a first study, use the existing authored research-plan artifact, including discovery/confirmation status, economic acceptance, data-exposure/search inventory and uncertainty plan. Hash identity-relevant content into job configuration and preserve it with `context.writeArtifact`. Keep it separate from `evaluateStudy.protocol`, whose accepted keys are deliberately narrow. A new general schema is only useful if repeated studies demonstrate inconsistent admission or reporting.

This makes thesis changes and cross-campaign budget decisions reviewable. It cannot prove a hypothesis was devised without seeing prior results or discover work outside the registry. A useful acceptance check connects every candidate/stress variant to the frozen plan and preserves conflicts through existing immutable job identity checks.

Basis: [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), `src/experiments.mjs`, `src/search.mjs`, `src/study.mjs`.

### 2. A reusable robustness-study summary

Existing grids and the ETH campaign can already vary costs and parameters. What is missing as a shared research interface is a summary of neighboring-parameter stability, signal ablations, fold/regime contributions, and break-even cost/delay/liquidity assumptions. Build that orchestration on existing jobs and audits, retaining separate execution identities for stress populations. Do not relax `selectStudy`'s comparable-identity checks to fit stress results into one ranking.

Report the edge relative to controls over the declared scenario range, including failures and isolated optima. Acceptance should show that mixed execution models remain labeled as separate populations and that omitted/failed cells remain visible. This is especially useful before expanding model complexity.

Basis: [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), [Walk Forward Optimization](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization), `src/search.mjs`, `src/study.mjs`, `experiments/eth/worker.mjs`.

### 3. Trading-return uncertainty and selection diagnostics

The shared study API computes ordinary Sharpe and exact validation-return ranking, not confidence intervals, probabilistic Sharpe or selection-adjusted significance. The bootstrap in `experiments/speed/statistics.mjs` measures engine performance and does not supply a strategy-return inference method.

Add a separately documented numerical analysis layer over regular paired candidate/control returns, with explicit dependence assumptions, baseline excess-return uncertainty and the complete recorded search across agents/studies. Study streaming summaries alone are not a return panel; preserve or reconstruct it from retained valuation audits on the declared grid. QuantConnect documents probabilistic Sharpe; correction for searching many candidates is an additional problem and should be treated separately. Missing prior-search history remains a limitation. Reuse suitable established numerical utilities and verify formulas against primary statistical references before implementation. Analytic cases, correlated-return fixtures and deliberate winner selection are meaningful validation cases.

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

The 2026-10-03 swarm-audit update aligns all seven entrypoints with current official campaign/final-release APIs and expands their existing references for frozen inputs/packages, shared admission/recovery, economic rejection, complete search accounting and intraday data/execution admission. UI metadata and automatic invocation policy are preserved. These are skill/documentation changes; the framework's selector, economic contracts and inference capabilities are unchanged. See [the audit](SWARM_RESEARCH_AUDIT.md) for the motivating findings.

All seven skill entrypoints and linked references passed Skill Creator's validator and local path validation; the entry skill's routing links resolve to all six specialists. Earlier independent behavioral forward tests covered realistic research and cross-venue strategy/model requests, and a build-independent callback/runner check passed. The update was checked against current campaign implementation and a representative bounded swarm plan, including rejecting a negative-return winner without consuming final evidence. These checks validate guidance and operational reasoning, not trading profitability. No campaign ran as part of skill validation and no final data was consumed. Automatic skill discovery remains enabled; synchronized installed copies may require a fresh session to load.
