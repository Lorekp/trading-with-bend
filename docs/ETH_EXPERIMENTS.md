# ETH data experiments

Run from the repository root:

```powershell
npm test
npm run eth-demo
```

The campaign creates a unique registry under `output/eth-*`, prints its summary
path, and runs two worker processes at a time. To choose a shared registry and
download manifest explicitly:

```powershell
npm run eth-demo -- output/my-eth-study data/binance/um/ETHUSDT/2026-09/manifest.json
```

A job key is immutable: rerunning the same registry is idempotent only when all
code, data, configuration and build evidence match. Choose a new registry after
changing shared code. Each attempt retains its report, data provenance, model
artifacts, timings, logs and status. Failed trials remain in the summary. No
strategy winner is selected automatically.

Audit every stored trial independently after a campaign:

```powershell
node scripts/audit-eth-campaign.mjs output/my-eth-study
```

The audit checks artifact digests, reconstructs every cash/inventory posting,
checks fees, limits, causal timestamps and shared liquidity budgets, and validates
every fitted model's chronology and scaler lineage. It writes a separate unique
audit JSON without modifying the registered artifacts.

## Dataset and execution contract

The supplied September download contains USD-M perpetual data. Its minute
klines have 43,200 contiguous rows; the campaign uses 8,640 completed five-minute
bars across the entire month. Three auxiliary price series each have 43,200 rows,
and the funding archive has 90 observations. bookTicker was unavailable. The
small-data adapter verifies archive SHA-256, length, ZIP metadata and CSV CRC,
streams without extracting, checks chronology/OHLC/units/declared calendar
coverage, and refuses unsupported formats. It does not scan the 1.2 GB trade ZIP.

This is **development verification of a cash-only simulator using perpetual
prices**. It does not simulate perpetual contracts, margin, leverage, liquidation
or funding payments. Auxiliary data can be loaded for research but is never
silently booked into this cash ledger. Results are not evidence from an untouched
final holdout or calibrated estimates of venue fills.

| Setting | Default campaign meaning |
| --- | --- |
| Cash | 10,000 USDT, represented as 10,000,000,000 microUSDT |
| Quantity | 1 lot = 0.001 ETH; target cap 1,000 lots = 1 ETH |
| Price | microUSDT per lot = USDT per ETH × 1,000 |
| Tick | 10 price units = 0.01 USDT per ETH |
| Fee | Fixed 1,500 microUSDT per filled lot; illustrative, not a venue schedule |
| Spread | Assumed 2 bps on each side, rounded outward to ticks |
| Limit collar | Decision close ±100 bps, rounded outward |
| Liquidity | Each side: floor(previous completed bar volume × 10/10,000), capped at 10,000 lots |
| Order/cancel delay | 1 ms each |

A completed bar becomes available at its inclusive `close_time + 1 ms`, which
coincides with the next bar's open timestamp. The modeled quote occurs **1 ms
after** that next open, at the recorded open price plus/minus the assumed spread.
Holding the open price fixed for that millisecond is an explicit hypothetical
execution assumption. It is not an observed bid/ask quote. Current-bar volume
never supplies the opening liquidity budget. Close observations have zero fill
liquidity. Gaps outside a limit collar may leave orders unfilled. Reconciliation
can cancel stale pending orders and miss an opening opportunity.

Trailing and channel exits are completed-bar decisions; a high/low touch never
gets an invented intrabar stop fill. Final inventory is marked at the final
modeled bid, with no fabricated liquidation or hypothetical exit fee. No final
order is submitted, although final feature/prediction diagnostics are retained.
The irregular open/close valuation samples have no automatic annualized Sharpe.

## Strategies and reusable API

The six trials use a common dataset/window: hold, moving-average crossover,
volatility-scaled breakout, two walk-forward ridge regularization settings, and
a higher-cost/lower-liquidity crossover scenario. The breakout uses ATR sizing,
trend and channel filters, trailing/channel exits, and cooldown measured from
actual liquidation. Ridge uses causal return/volatility features, training-only
scaling, strictly matured one-bar labels, a bounded rolling training window,
scheduled retraining, and an explicit training/deployment delay. Complete model
and scaler artifacts are saved for every fit. Parameters are examples for system
verification; the campaign is not a strategy-selection recommendation.

```js
import { loadBinanceBars, createBarStrategy, runBarStrategy } from './src/index.mjs';

const { bars, provenance } = await loadBinanceBars({
  manifestPath: 'data/binance/um/ETHUSDT/2026-09/manifest.json',
  intervalMinutes: 5,
});
const strategy = createBarStrategy({ type: 'ma-cross', quantity: '1000', fast: 12, slow: 48 });
const result = runBarStrategy(config, bars, strategy, { maxPositionLots: '1000' });
const report = result.report();
// Supply config as in experiments/eth/worker.mjs, which also registers artifacts.
```

Factories are stateful; create a fresh one for each replay. Custom `onBar` returns
canonical target lots or explicit `null`, and sees only immutable completed
history, the current ledger and working orders. Closed orders remain available
in the underlying backtest/report. The history bound must cover `strategy.lookback`.
Unknown options fail. Callback closures/file access remain trusted code, not a
sandbox. Engine checkpoints restore accounting/events only; resuming a stateful
strategy requires replaying its feature/model history or separately saving it.

For parallel agents, copy the worker into `experiments/<study>/`, use the shared
modules, and register all external imports and dataset files in `dependencies`.
The campaign pins the manifest, candle archives and checksum sidecars. Loaded
source hashes bind the toolkit. A worker that sees dependency changes fails
instead of silently mixing versions.

## Performance and checks

`scripts/benchmark.mjs` accepts `--ticks`, `--orders`, `--lookback`, `--trace`,
`--order-storage`, and optional `--profile`. For example:

```powershell
npm run benchmark -- --ticks 43000 --orders 500 --lookback 64 --trace compact --order-storage active
```

Bounded history avoids cloning an ever-growing prefix. Immutable state reuse
avoids repeatedly freezing identical order records. Bend's working-order filter
keeps completed orders out of matching scans; the host retains their full audit
records and preserves delayed cancellation metadata. Compact traces omit only
per-event copies of all orders. Event logs, fill records, final orders and
valuation samples remain available.

Active/compact storage is approximately proportional to events plus working
orders per event and retained audit history. Full trace mode can still grow with
events × historical orders; unbounded callback history still copies growing
arrays. This is not a tick-level replay of the bulk trade archive.

E2E checks compare the active path with the all-order reference, including exact
trace hashes, partial fills, cancellation races, rejected orders, failure
atomicity and checkpoint continuation at every tested event boundary. Additional
tests alter future bars, inject archive/data corruption, reconstruct the cash
ledger independently, execute real ML/rule workers, and tamper with saved model
and result artifacts. The proof contract describes which smaller Bend laws are
universal and which complete workflows are tested instead.

## Verified local run: 2026-10-02

All six full-month trials completed under `output/eth-september-verified-v03` and
passed the independent saved-artifact audit. They used the same bar hash
`d261b66704db6cb8baa9d87e414865eead302bef83fa6db1021f820f1f49e50b`.
The run produced 1,391 fills and 356 saved ridge models. These are illustrative
cash-proxy results, including open inventory; they are not perpetual returns or
evidence that any strategy generalizes.

| Trial | Fills | Fitted models | Net P&L (USDT, rounded) | Ingest + replay + report |
| --- | ---: | ---: | ---: | ---: |
| Hold | 1 | 0 | 215.65 | 3.75 s |
| MA crossover | 240 | 0 | -409.21 | 4.07 s |
| MA crossover, cost/liquidity stress | 509 | 0 | -1,231.97 | 4.22 s |
| Ridge, alpha 0.1 | 212 | 178 | -310.98 | 21.32 s |
| Ridge, alpha 10 | 188 | 178 | -353.99 | 21.60 s |
| Volatility breakout | 241 | 0 | -475.50 | 4.68 s |

Timings are single local measurements with two workers, Node 22.13.1 on Windows;
they exclude writing the final artifacts and are not performance guarantees.
Each worker's recorded RSS snapshot was approximately 126–130 MiB (not peak RSS).

The synthetic 43,000-quote/500-order benchmark fell from 140.080 s with bounded
history/compact trace and all-order matching to 2.518 s with active matching.
Both produced 500 fills and the same compact trace hash
`a67103a658548bb7cbec910be15f18e8a9da2d44076d6cafc5821b6fa4fcfcae`.
The 2,000-quote/50-order default benchmark fell from 10.403 s before any changes
to 0.827 s while preserving its full trace hash. These measure different workloads
and should not be combined into a single speedup claim.
