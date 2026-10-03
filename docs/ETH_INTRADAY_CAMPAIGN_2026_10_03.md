# First ETH intraday campaign: no acceptable strategy

Completed on 2026-10-03 using main `e9bdb63`, the updated Bend research skills,
and the study code under [experiments/eth-intraday](../experiments/eth-intraday/README.md).
All 20 registered jobs completed: two cash preflights, twelve base candidates,
and six stress candidates. All twelve base candidates lost money after costs.
The six stress candidates also lost money. No final data was released.

The official base winner was `reversal/lookback-120/threshold-10`. It failed the
predeclared economic acceptance rule. No other candidate was substituted.

## Scope and assumptions

Inputs cover September 1–7, 2026, a previously exposed development month.
September 1 supplies initial history; validation consists of September 2–3,
4–5 and 6–7. Each validation fold starts with 10,000 USDT. Aggregate return
divides summed P&L by 30,000 USDT of summed initial capital; this is not one
compounded account or an annualized return.

The input snapshot has 10,079 published Binance minute observations and 20,178
OKX derivative events: 10,079 marks, 10,079 quote proxies and 20 funding events.
Processed shard hashes, chronology, minute continuity and the exact eight-hour
funding grid were admitted. This run did not reread the original raw archives;
their hashes remain inherited provenance.

Execution uses the existing linear perpetual venue: actual admitted OKX marks
and funding, with synthetic bid/ask quotes from completed OKX candle closes.
The assumed half-spread is 0.10 USDT per ETH, and each side receives 0.1% of the
completed bar's volume. These are model assumptions, not observed executable
quotes or a reconstruction of market impact. The base fee is 5 bps per fill,
with 1-second order/cancel latency. Stress uses 10 bps per fill, 120-second order
latency and 60-second cancellation latency. The 10 bp `slippageBps` setting is
an order-limit collar, not a second slippage fee.

All candidates target at most one ETH, with 100% initial margin. Signals use
30/60/120-minute completed returns, continuation or reversal, and a 0/10 bp
entry threshold. They request an exit at a 60-minute holding horizon measured
from first observed exposure, and cancel entries when the signal disappears,
reverses or ages out. Actual exits can lag through cancellation and liquidity.
A 15-minute cooldown starts only after observed flat holdings and no working
order. All noncash variants request flat five minutes before each fold ends.

## Complete base population

Exact net P&L below is in USDT, summed across the three independent folds.

| Family | Lookback (minutes) | Threshold (bps) | Net P&L |
| --- | ---: | ---: | ---: |
| Continuation | 30 | 0 | -549.333537 |
| Continuation | 30 | 10 | -731.245494 |
| Continuation | 60 | 0 | -523.427629 |
| Continuation | 60 | 10 | -540.348619 |
| Continuation | 120 | 0 | -497.931841 |
| Continuation | 120 | 10 | -561.312061 |
| Reversal | 30 | 0 | -615.744977 |
| Reversal | 30 | 10 | -568.010109 |
| Reversal | 60 | 0 | -382.765487 |
| Reversal | 60 | 10 | -554.116975 |
| Reversal | 120 | 0 | -305.096154 |
| Reversal | 120 | 10 | -303.165467 |

Common base controls returned 0 USDT for cash, +66.473478 USDT for one-ETH
hold, and -82.556212 USDT for one-ETH short. Controls use the same information,
execution, folds and terminal exit policy. They are directional controls,
not perfectly exposure/turnover-matched counterfactuals.

## Official winner and stress population

| Winner measure | Base | Higher fee/delay |
| --- | ---: | ---: |
| Net P&L, USDT | -303.165467 | -670.842063 |
| Aggregate validation return | -1.010552% | -2.236140% |
| Fees, USDT | 441.088281 | 729.573920 |
| Positive folds | 0 of 3 | 0 of 3 |
| Largest fold drawdown, USDT | 152.460779 | 236.667891 |
| Liquidations | 0 | 0 |
| Terminal position, every fold | 0 ETH | 0 ETH |

The base winner's P&L before subtracting fees, with the same simulated fills
and funding, is +137.922814 USDT. This arithmetic diagnostic does not show that
a cheaper execution policy would preserve those fills. Fees exceed that gross
amount. All three net fold results are negative: -133.997115, -31.128904 and
-138.039448 USDT.

The winner traded 357.766 ETH of gross turnover in 728 base fills, versus
296.148 ETH in 618 stress fills. Its longest actual holding episode lasted
306 minutes in base and 329 minutes under stress. These exceed the 60-minute
exit-request horizon because limit orders, cancellation and liquidity can delay
closure. This is a material execution limitation, not a hard 60-minute strategy.

Stress tested the six highest-return valid base candidates, following the
frozen selection rule. This is further exploration on the same observations,
not an independent confirmation population.

| Candidate | Stress net P&L, USDT |
| --- | ---: |
| Continuation, 120 minutes, 0 bp | -763.333619 |
| Continuation, 60 minutes, 0 bp | -837.609500 |
| Continuation, 60 minutes, 10 bp | -775.931515 |
| Reversal, 120 minutes, 0 bp | -672.603594 |
| Reversal, 120 minutes, 10 bp | -670.842063 |
| Reversal, 60 minutes, 0 bp | -691.931155 |

The winner passed the drawdown/no-liquidation/flat-terminal checks but failed
positive net P&L, improvement over controls, minimum two positive folds and
positive stressed P&L. The numerical ranking therefore yields **no acceptable
strategy**. These results reject these configurations under this declared model
and period; they do not reject every possible ETH intraday strategy.

## Verification and retained evidence

The pinned Bend compiler and Lean kernel checks passed. `npm test` passed 169
tests, with three skipped and zero failures. Three focused signal tests passed,
including invalidated entry cancellation, late partial fills, cooldown and
holding/entry expiry. All seven skills passed validation; local skill links and
installed-copy hashes were checked. Sol 6.1 agents at high reasoning effort
handled skill updates, data preparation and independent review.

Independent post-run checks verified 620 artifact entries, read 240 complete
fill audits containing 14,028 fills, reconciled exact fees/wallet/net results,
and validated 60 paired equity panels containing 691,200 grid points across all
variants. Official selections and the six stress admissions were independently
recomputed from the complete populations. The winner's six base/stress fold
audits also passed source/decision/arrival timing, limit, cancellation, liquidity
and position-cap checks. These checks validate the declared simulation and
retained evidence, not observed exchange fillability.

One review clarification was applied after the frozen run: the current runner
checks the 5% initial-capital drawdown limit for both base and stressed winner.
The original runner checked base drawdown only. Review of the original stress
artifacts confirms a maximum of 236.667891 USDT versus the 500 USDT threshold,
so this clarification changes neither the decision nor any trading result.
Original manifests, reports and frozen executable bundles remain unchanged.

Local immutable evidence:

- [Research plan](../output/eth-intraday-20261003-v1/research-plan.json)
- [Complete summary](../output/eth-intraday-20261003-v1/summary.json)
- [Official base report](../output/eth-intraday-20261003-v1/base/report.json)
- [Official stress report](../output/eth-intraday-20261003-v1/stress/report.json)
- [Preflight population](../output/eth-intraday-20261003-v1/diagnostics.json)
- [Input admission and provenance](../output/eth-intraday-inputs/admission.json)

Input content identity is
`456adef549631d3a6c3be7e5e3d573f06215910febf779babefa917c24725e97`.
Each completed attempt retains full disk audits, per-fold studies and aligned
regular equity histories for candidate/cash/hold/short. These output directories
are intentionally local ignored artifacts; preserve them with the frozen bundle
and input stores when sharing or archiving evidence.

Seven development days, a selected winner, and bar-proxy fills cannot establish
future profitability or statistical significance. No selection-adjusted
confidence measure was computed. The appropriate next research decision is
to reconsider turnover and executable signal size before widening the search,
and to acquire/calibrate actual quote execution before promoting any future
bar-proxy winner. No further search or live trading was started by this run.
