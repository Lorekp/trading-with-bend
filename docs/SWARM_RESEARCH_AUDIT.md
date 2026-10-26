# ETH intraday research swarm: skill audit and proposed changes

Audit date: 2026-10-03. Scope: ETH intraday using existing downloaded data;
review and proposals only. No strategy campaign or final-data release was run.
Three agents independently reviewed skills, repository/data readiness, and
primary-source strategy research. Installed and repository copies of all seven
Bend research skill entrypoints matched at inspection.

The most useful first change is to bring the skills up to date with the existing
campaign implementation. The next priorities are executable data, an explicit
economic acceptance rule, and accounting for the combined search across agents.
More candidate generation alone does not establish a tradable edge.

## Existing capabilities to use

The repository already exports `createCampaign`, `releaseCampaignFinal`, frozen
worker bundles, shared resource admission, immutable trial membership, complete
population reports, verified artifacts, and single-use final release. It also
has derivative funding, signed positions, margin, liquidation and expiry.
These are not missing infrastructure. See [RESEARCH.md](RESEARCH.md),
[campaigns.mjs](../src/campaigns.mjs), [campaign-final.mjs](../src/campaign-final.mjs),
and [DERIVATIVES.md](DERIVATIVES.md).

Formal accounting/policy checks do not establish vendor completeness, economic
fill realism, or future returns. The single-contract derivative venue does not
model a jointly margined spot/perpetual hedge. See [CONTRACT.md](CONTRACT.md).

## Changes to the skills, in priority order

| Priority | Files | Proposed change | Acceptance check |
| --- | --- | --- | --- |
| P0 | `skills/bend-research/SKILL.md`; `skills/bend-experiment-campaigns/SKILL.md` | Route official multi-agent studies to `createCampaign().submit/seal/run/report`. Keep raw queues for focused diagnostics. Name one coordinator responsible for specification, total budget, common inputs and reporting. | A sample swarm plan uses the campaign API, counts every admitted candidate, seals membership, and waits for all terminal statuses before official selection. |
| P0 | Entry skill; `bend-research-design/SKILL.md`; `references/falsification.md` | Use `releaseCampaignFinal` for official campaigns with one absolute shared `finalAuthorityDirectory` across checkouts. Give explorers train/validation-only payloads; the coordinator owns final values. Retain `withFinalHoldout` as the lower-level helper. | Exploration inputs contain no final values, including embedded configuration or bundled files; existing denial/release tests pass. Failure consumes the final claim. |
| P0 | `bend-research-design/references/study-design.md`; analysis skill | Require a frozen capital/notional scale, holding horizon, benchmark, costs, drawdown/exposure limits, capacity assumptions and a rejection rule. Define "no acceptable strategy" as a valid result. | An all-losing population can have a numerical winner while the research decision is rejection; no alternative winner is quietly substituted. |
| P0 | Campaign `references/operations.md` and `references/registration-and-artifacts.md` | Document frozen toolkit/installed-package/input copies, `inputFiles`, filesystem versus trusted workers, common `admissionRoot`, identical resource budgets, per-job declarations, output limits, telemetry and recovery. | Concurrent runners respect shared admission; originals changing do not alter frozen jobs; dead-owner recovery checks both process owners and shared reservations. |
| P1 | `bend-backtest-analysis/references/metrics-and-conclusions.md`; design falsification reference | Make search-wide uncertainty planning standard for profitability-seeking swarms. Record previous studies/manual changes, preserve regular return evidence, and declare a dependence-aware method before looking at winners. | The report counts losing/failed/abandoned work and previous searches, documents missing evidence, and never interprets ordinary Sharpe as a probability of profit. |
| P1 | `bend-data-causality` and `bend-strategy-development` references | Add an ETH intraday admission checklist covering actual overlapping coverage, publication versus receipt time, historical contract assumptions, taker costs, stale books/marks, partial fills and funding information timing. | A candle-only proxy cannot be presented as executable perpetual evidence; ex-post settled funding cannot be used as a pre-settlement forecast. |

These are proposed edits; this audit does not modify the skills or installed
copies. Update the versioned repository skills first, verify their links and
behavior against current code, then synchronize installed copies explicitly.

Two especially concrete stale statements are in the campaign references:
`operations.md` describes mutable-source drift rejection without frozen campaign
semantics, and `registration-and-artifacts.md` says hashes do not bind installed
dependency bytes. Frozen bundles now inventory and copy those bytes; integrity
still does not prove trustworthy dependency behavior.

## Selection needs an economic acceptance decision

[selectStudy](../src/study.mjs) ranks exact aggregate validation return. It can
choose a negative-return strategy, and has no eligibility requirement for
benchmark improvement, drawdown or capacity. The campaign specification accepts
only `aggregate-validation-return`; final release binds that official winner.

For the first campaign, retain the existing selector and apply a predeclared
accept/reject decision to its winner. If it fails, stop with no acceptable
strategy. Do not filter the population after seeing results, promote a different
candidate, or describe a custom ranking as the campaign's official selection.
If constrained risk-adjusted selection is wanted, extend and test the frozen
selection contract before running the search.

Before launch, fill in capital, maximum gross exposure, permitted shorting,
drawdown/loss limits, actual fee tier and minimum useful net edge. Keep return
ranking comparable by fixing capital and risk assumptions across candidates.
Intraday also needs an explicit maximum holding time and policy for crossing
funding times or daily boundaries; crypto has no universal daily close.

The skills already request an authored research-plan artifact. Start by adding
these decisions to that artifact and its job configuration hash; a new general
schema/framework is not necessary for a first study. Keep thesis metadata out
of the narrowly validated `evaluateStudy.protocol`.

## Downloaded data and readiness

The active worktree has no `data/`, `node_modules/`, generated `build/`, or prior
`output/` directory. Downloads were located in the main checkout's local `data/` directory.

Manifest-only inspection found January through September 2026 for Binance
ETHUSDT and OKX ETH-USDT-SWAP:

- `data/binance/um/ETHUSDT/2026-MM/manifest.json`
- `data/okx/swap/ETH-USDT-SWAP/2026-MM/manifest.json`

| Source | Manifest status relevant to this study | Implication |
| --- | --- | --- |
| Binance | Funding, mark/index/premium, klines and trades reported complete; bookTicker incomplete | Useful information inputs subject to file/timing admission; do not assume executable Binance BBO exists. |
| OKX | L2, trades, candles, funding, mark/index reported complete; premium history partial; instrument reference is current/retrieval-time | Candidate execution source, subject to reconstruction, checksums, actual overlap and explicit historical contract assumptions. |

These are manifest declarations, not a fresh verification of archive bytes,
continuous event coverage or fillability. Overall incomplete manifests need
dataset-specific admission; missing required inputs must fail explicitly.
The older [ETH example documentation](ETH_EXPERIMENTS.md) describes a narrower
September inventory. Do not treat that example as the full available archive.

September was already used for full-month development trials. Treat it as
exploratory. The presence of January-August archives does not establish that
those months are untouched: inspect prior studies and analyst/agent exposure
before allocating confirmation data. If no credible untouched period exists,
freeze the protocol and collect future data for confirmation.

Recommended starting economic scope: Binance ETH information with independently
supplied OKX ETH perpetual execution on the verified common window. This is a
proposal, not an existing verified campaign. Use `DerivativeExecutionVenue`
for perpetual economics. The ETH cash-price bar example is useful for plumbing
and coarse screening, not evidence of executable perp returns.

The existing `experiments/eth/worker.mjs` returns a development summary, not the
complete `validation-study-v1` required by official campaigns. Reuse appropriate
helpers inside an `evaluateStudy` worker rather than submitting that demo worker
unchanged. Node v24.12.0 is available, but this worktree still needs its locked
dependencies, pinned compiler/kernel and verified build; main-checkout build
artifacts cannot be presumed to match this version.

Select and snapshot only required files into campaign inputs. Verify manifests,
archive hashes, L2 reconstruction, units, marks, settlement data, gaps and
source/venue overlap. Current metadata cannot establish historical contract
specifications. Historical exchange timestamps without local receipt times also
cannot establish a subsecond cross-venue lead/lag advantage.

## Suggested swarm and bounded first study

Use four simultaneous roles, with the coordinator reviewing final evidence:

1. Coordinator/data custodian: fixes assumptions, exposure inventory, splits,
   resource budget and total trial allocation; owns final authority.
2. Trend researcher: one ETH intraday continuation family, in its own experiment
   directory, with a small prespecified neighborhood of lookbacks/holding times.
3. Reversal researcher: one conditional reversal family and its prespecified
   neighborhood, using the same risk scale, windows and execution assumptions.
4. Independent critic: audits leakage, fills, costs, parameter stability and
   fold contributions; does not tune a competing strategy to the same results.

Begin with interpretable signals at minute-to-hour decision horizons. A proposed
engineering budget is 12 base candidates (six per family), six signal ablations,
and six fixed stress jobs: at most 24 admitted jobs across the study. This is a
resource proposal, not a statistically justified trial count. Freeze allocation,
stress scenarios, and any deterministic rule for choosing stress representatives
before outcomes. Controls run inside each comparable study. Stress populations
retain separate execution/comparison identities. The coordinator must count all
jobs across those campaigns; an individual campaign's `maxTrials` cannot enforce
a cross-campaign total. Failed jobs consume budget; any recovery retains history.

Start with at most two replay workers until a representative slice establishes
memory, runtime and disk needs. Set CPU/thread/memory and output budgets from
that measurement. Four reasoning agents do not each receive an independent
four-worker replay allowance. Build and verify once before freezing campaigns.

Research priority is conditional continuation versus reversal. Funding/premium
can later be a crowding feature if publication-time history is defensible.
Do not begin with a giant indicator grid, a large ML architecture search,
subsecond cross-venue arbitrage, or hedged carry under a single-contract model.
The primary-source rationale and precise falsifiers are in
[SWARM_STRATEGY_RESEARCH.md](SWARM_STRATEGY_RESEARCH.md).

## Evidence required before calling an edge promising

Preserve exact net P&L, cash and hold baselines, comparable exposure, every fold,
turnover, open positions, stale marks, fees/funding and full fill audits. Retain
regular paired strategy/control return evidence for subsequent analysis;
`evaluateStudy` streaming summaries alone are not a full return panel. Independent
reset folds are not one compounded equity curve.

Predeclare realistic higher-cost/delay/lower-liquidity scenarios and report
break-even costs, parameter neighborhoods, and concentration in a few periods.
For intraday trading, whether the estimated edge survives plausible frictions
is a first-order question. Book depth by itself does not validate queue position
or realized fills. Calibrated paper/execution reconciliation is a later required
evidence stage before a deployment claim; the repo currently supplies replay.

Searching more candidates inflates selected performance. The
[Deflated Sharpe Ratio paper](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
motivates recording search breadth and non-normal returns; it is not an automatic
repair for unknown prior searches, dependent intraday returns or bad execution.
Choose a justified dependence-aware benchmark comparison/selection diagnostic
and preserve its assumptions. The repo does not currently supply a shared
strategy-return selection-adjusted inference layer. When evidence is inadequate,
report uncertainty rather than manufacturing a confidence score.

Hypotheses, competing explanations and rejection criteria should precede the
search; exploration remains valid when honestly labeled. This follows the
[QuantConnect research guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide).

## Proposed implementation order and verification

First align the skill entrypoints/references with existing campaigns. Then create
the ETH input/exposure inventory and research-plan artifact. Next prepare a tiny
end-to-end derivative study with common controls and retained audits. Only after
that path works should the bounded family search begin. Add statistical reporting
and calibrated execution evidence before promoting a result to a profitability
claim; add new infrastructure only where the study demonstrates a concrete gap.

For skill-only changes, validate links and exercise a representative swarm plan.
For shared selection/statistics/runner changes, follow the repository's required
`npm test` and `npm run test:regression` checks. The existing swarm acceptance test
is `node --test tests/e2e/swarm.test.mjs` after building; its synthetic success is
not strategy evidence. No runtime tests were run for this documentation-only audit.
