# ETH intraday strategy research for an agent swarm

Research date: 2026-10-03. Scope: audit and proposed research design using the
downloaded ETH data. No strategy campaign, final evaluation or trading was run.
Recommendations below are hypotheses, not demonstrated local profits.

## What the external evidence changes

Start with a small contest between intraday continuation and conditional
reversal, then test whether already-published funding/crowding information adds
anything. Make executable net return the admission hurdle. Prediction accuracy
alone is insufficient.

An unusually relevant recent preprint illustrates why: Kitron and Wengrowicz
(2026-08-22) report 15-minute directional reversal including ETH, but their
BTC/ETH capture analysis peaks near 1.3 basis points gross per trade, below their
5-basis-point benchmark spot round-trip cost. This is a preprint, not a replicated
result in this repository; its spot cost assumptions are not this user's
perpetual fee schedule. Its wide-universe analysis also has survivor-selection
limitations. The useful research lesson is to test the economic size of a signal
before building more elaborate predictors. [Paper and limitations](https://arxiv.org/html/2608.21888v1).

Older evidence does not justify assuming one universal direction. Wen et al.
(2022) report both intraday momentum and reversal in Bitcoin, conditional on
liquidity, jumps and other states; their Bitcoin sample runs from 2013 to 2020.
This motivates competing hypotheses, not direct transfer to current ETH.
[Publisher abstract](https://www.sciencedirect.com/science/article/pii/S1062940822000833).
Zaremba et al. (November 2021) find daily cross-sectional reversal concentrated
in less liquid coins, with daily momentum in the largest tradable coins.
Daily cross-sectional results are not evidence for ETH intraday mean reversion.
[Publisher abstract](https://www.sciencedirect.com/science/article/pii/S1057521921002349).
Liu and Tsyvinski's August 2018 momentum evidence is likewise a broad research
prior, not an ETH intraday strategy specification. [NBER paper](https://www.nber.org/papers/w24877).

## Three bounded hypotheses

The horizons below are proposed starting choices, not estimated optima. Freeze
them before inspecting their validation profits. Do not expand all combinations
of indicator, horizon, threshold, exit and sizing into an uncontrolled grid.

| Priority | Hypothesis and smallest experiment | Required information | Falsifier / alternative explanation |
| --- | --- | --- | --- |
| 1 | Intraday continuation: a completed 30-, 60- or 120-minute move continues over a separately fixed intraday holding period. Compare a plain signed-return or breakout rule to the same rule with one training-fitted volatility filter. | Completed ETH bars, causal rolling statistics, explicit next executable event. Use constant risk/exposure rules across candidates. | Reject promotion if net baseline improvement disappears under a plausible extra decision delay/cost stress, is concentrated in one fold/day, or is replicated by an exposure-matched control. A rising market can reward incidental long exposure. |
| 2 | Conditional reversal: unusually large completed moves partly reverse over 15 or 30 minutes, with the hypothesis strongest after aggressive flow if that field is actually available. Start with the unconditional reversal and one separately registered state filter. | Bars suffice for an exploratory price-only signal. Flow conditioning requires admitted trade/taker-volume fields and their actual availability. Quote spreads/sizes are needed to assess capture beyond a bar proxy. | Reject promotion if the effect is mainly bid-ask bounce, if profitability requires trading at the signal bar close, or if realized edge per turnover is below costs. Compare against continuation and a no-filter ablation; exclude no losing periods after seeing them. |
| 3 | Funding/crowding conditioning: lagged settled funding or an archived, already-published premium changes the usefulness of an intraday continuation/reversal signal. Compare the same parent signal with and without the one feature. | Historical realized funding for account cash flows; publication-timed information for predictors; compatible mark and execution series. An archive of settlement rates alone does not reconstruct pre-settlement estimates. | Reject promotion if improvement vanishes after correct publication lag, exists only because the eventual funding rate was known early, or adds no incremental value versus the price-only parent. Funding receipts can coexist with larger directional losses. |

These are proposed local experiments, not claims made by the cited studies.
Keep the initial candidate count small; each filter, horizon change, manual
revision and failed attempt belongs to the disclosed search history. With only
a short common data window, describe results as exploratory screening. More
agents cannot manufacture independent market regimes.

## Funding, basis and the local execution boundary

BIS Working Paper 1087 (originally 2023-04-04) documents large, variable crypto
futures carry and relates it to speculative demand, limited arbitrage capital
and crash risk. That supports investigating crowding and carry economics;
it does not establish a riskless funding-harvest rule. [BIS research](https://www.bis.org/publications/working-paper-1087-crypto-carry).

The repository already supports linear/inverse derivatives, signed positions,
funding, margin, liquidation and expiry. Its current venue is one contract and
one settlement currency. It does not supply a joint spot-plus-perpetual account
with hedge execution, collateral transfers and portfolio margin. Summing two
independent backtests would not establish the feasibility of a funded cash-and-
carry trade. Keep true hedged basis/carry outside the first intraday campaign.
[Local economic contract](DERIVATIVES.md),
[venue implementation](../src/derivative-execution-venue.mjs).

The processed ETH bridge admits mark, funding and quote/bar series. Displayed
size replenishes with each book update; bar-volume execution synthesizes a
spread and participation budget. Neither reconstructs persistent book depletion,
queue priority or impact. A bar-only success therefore remains evidence under
an execution proxy, especially weak for fast reversal. The bridge uses a recent
published mark as an explicit funding settlement-price assumption. Compare that
assumption with the actual charge-price data when available.
[Processed bridge](../src/executable-data.mjs), [execution assumptions](DERIVATIVES.md).

Binance's current funding-history API returns `fundingTime`, `fundingRate` and
the mark associated with the funding charge; funding-info exposes interval/cap
adjustments. Those are different purposes from reconstructing the estimate
visible before settlement. The current basis-history endpoint is limited to
the latest 30 days. Preserve existing historical archives and timestamps;
today's response cannot reconstruct arbitrary old receipt times or historical
settings. [Official API, checked 2026-10-03](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data).
The local derivative model has a fixed funding schedule per dataset; split
variable-schedule coverage into explicitly declared datasets. [Local admission rules](DERIVATIVES.md).

For all three hypotheses, maintain separate observation, publication/receipt,
decision, arrival and fill times. A completed candle's open timestamp is not its
availability time. Backfilled vendor event timestamps do not prove when a live
strategy could receive information. If receipt history is absent, label the lag
assumption and stress it. Venue cash-flow events may occur at settlement even
when a strategy learns their details later. [Local timing contract](CONTRACT.md).

## Statistical controls worth adding to the skill guidance

1. **One complete search history.** Freeze the candidate population, objective,
   benchmark, data/split identities, trial budget and stopping rule across the
   swarm. Retain manual revisions and previous searches against reused data.
   A new registry name does not create fresh evidence. The existing campaign
   infrastructure already provides immutable admissions and complete status
   histories; use it instead of a new leaderboard. [Local campaigns](RESEARCH.md).

2. **Retain aligned regular returns, not only winning summaries.** For every
   valid candidate and benchmark, retain per-fold regularly sampled returns
   and timestamps, alongside costs, turnover, exposures and full audit hashes.
   Keep failures as statuses; do not invent zero returns for a crashed trial.
   Preserve fold boundaries and capital resets in any statistical analysis.
   The current selector ranks exact aggregate validation return and does not
   enforce significance, drawdown or capacity. [Selector](../src/study.mjs),
   [local metrics guidance](../skills/bend-backtest-analysis/references/metrics-and-conclusions.md).

3. **Use DSR as a documented diagnostic.** Bailey and Lopez de Prado's Deflated
   Sharpe Ratio (2014-07-31 author version) adjusts the Sharpe hurdle for search
   selection and non-normality. Inputs include track length, skewness, kurtosis,
   cross-trial Sharpe dispersion and an effective independent trial count.
   Correlated variants are not independent draws; report how effective count is
   estimated and its sensitivity. A registry's raw job count is useful disclosure,
   not automatically the correct DSR input. DSR does not by itself repair serial
   dependence, execution errors or future regime changes. [Author paper](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf).

4. **For a searched population, consider a benchmark-relative Reality Check or
   SPA test.** White's Reality Check (2000) tests whether the best searched model
   beats a specified benchmark after accounting for selection. Hansen's SPA
   (2005) improves power/sensitivity to irrelevant poor alternatives. Apply the
   chosen method to aligned candidate-minus-benchmark performance series; use
   a justified dependence-preserving bootstrap and disclose block-length
   sensitivity. Do not resample each candidate independently or splice capital-
   reset fold boundaries into artificial returns. Their assumptions and the
   declared candidate universe still matter; neither certifies future profit.
   [White paper](https://users.ssc.wisc.edu/~behansen/718/White2000.pdf),
   [Hansen author manuscript](https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID264569_code244328.pdf?abstractid=264569).

5. **Separate discovery from confirmation.** Predeclare economic rejection
   criteria and the next decision before selection. Save execution stress runs
   as distinct comparison populations. A final untouched tail is released only
   after the strategy and protocol are frozen, through the existing canonical
   campaign authority. No final rows need to be consumed for this audit.
   [Local research design](../skills/bend-research-design/references/falsification.md),
   [campaign and holdout contract](CONTRACT.md).

The proposed statistical layer is additional analysis, not a claim that these
tests are already built into the trading-study API. Before implementing it,
choose one primary inference question and an appropriate maintained statistical
implementation; do not stack whichever tests make a winner look significant.

Source review used primary papers, publisher abstracts, exchange documentation
and local code. Full text of the older intraday publisher article was not
retrievable; its use above is confined to its published abstract. No quoted
historical return or fee schedule is a forecast for this ETH campaign.
