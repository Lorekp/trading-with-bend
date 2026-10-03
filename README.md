# Trading with Bend

A runnable, proof-oriented backtesting reference framework. The **cash accounting, order admission, reservations, cancellation and FIFO matching engine is written in Bend**. Node handles validated JSON input, strategy callbacks, checkpoints, reports and experiment registration around the compiled Bend module. Archive readers use the locked `tar-stream` and `yauzl` dependencies.

For parallel strategy agents and ML research, start with [the shared research guide](docs/RESEARCH.md) and `AGENTS.md`. The toolkit now includes a durable parallel job queue, programmatic strategies, causal features, ridge/OLS training, purged walk-forward evaluation, persistent final-holdout gates, parameter grids and reusable artifact checks. `src/index.mjs` exports the shared API.

For the downloaded ETHUSDT data, use [the ETH experiment guide](docs/ETH_EXPERIMENTS.md). `npm run eth-demo` runs six registered rule/ML scenarios over September's 43,200 minute candles, resampled into 8,640 completed five-minute bars. The source is **USD-M perpetual data with missing bookTicker**; these runs explicitly use a cash-only price proxy with assumed execution, not perpetual-futures accounting.

For a small forecasting example, see [the optional ML guide](docs/FORECASTING.md).
`npm run ml-demo` compares zero return, ridge, LightGBM and a PyTorch TCN using
60 completed minutes to predict the next five-minute return. It reuses the
research splits and registry, leaves final data unreleased, and requires the
separate Python dependencies in `requirements-ml.txt`.

For memory measurement, see the [benchmark research](docs/MEMORY_BENCHMARK_RESEARCH.md)
and [benchmark design](docs/MEMORY_BENCHMARK_DESIGN.md).

Each replay handles one instrument with integer lots and ordinary limit orders. Cash quote/bar venues and a separate derivative venue have explicit accounting and execution assumptions. It is a reference simulator, not a claim about market realism or profitable strategies.

## Run it

After the setup below, run from the repository root:

```powershell
npm run demo
npm test
npm run eth-demo
npm run backtest -- examples/demo.json --out output/my-report.json
```

`demo` builds, checks the Bend laws, runs the synthetic example and writes a unique file under `output/reports/` (its path is printed). It starts with 100000 EUR cents, buys two lots through partial fills, sells them through partial fills, and finishes at 100260 cents after 40 cents of fees. The example also fills an order while its cancellation request is in transit. Explicit `--out` paths are exclusive: an existing report is never overwritten.

For a fresh Windows checkout, install Node 22.16.0 or newer in the 22.x line, or Node 24+, and Git and provide an existing Ubuntu-24.04 WSL distribution, then run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

The setup script installs locked npm dependencies with `npm ci`, then downloads the pinned Bend revision and a checksum-checked Bun 1.3.10 binary into `.tools`. It does not install global packages or create a WSL distribution. Compilation uses WSL because this Bend revision's import loader assumes POSIX paths; Node runs the emitted JavaScript on Windows. Linux x86-64: run `bash scripts/setup.sh` with Node, Git, curl and unzip installed. On other supported Bend platforms, run `npm ci`, install Bun and clone the exact revision in `toolchain.json` into `.tools/bend` before `npm run build`. `BEND_BIN` can select an external compiler; reports then explicitly mark its revision as unverified.

The minimum Node version includes the SQLite iterator lifetime fixes in [Node 22.16.0](https://nodejs.org/en/blog/release/v22.16.0/). Earlier Node 22 versions and Node 23 can finalize statements during long reads and are unsupported. Node 22 still marks `node:sqlite` experimental. CI checks the minimum supported Node version and Node 24, including the Lean proof kernel and both test suites.

To use another installed WSL distribution, set `$env:BEND_WSL_DISTRO = 'Debian'` before setup, build or test commands. The default is `Ubuntu-24.04`.

## What is implemented

- Exact bounded integer cash and inventory; explicit fee postings; no floating-point ledger.
- Buying-power and sell-inventory reservations across all working orders.
- FIFO matching at bid/ask, partial fills and shared per-tick liquidity budgets.
- Order and cancellation latency, strict decision-time causality and cancellation races.
- Typed input/runtime errors, duplicate event idempotency and conflicting-ID rejection.
- Atomic event application with independent ledger reconciliation and invariant checks.
- Deterministic replay and checksummed event-sourced checkpoints.
- Ledger-derived net return, quote-sampled drawdown, fees and terminal open-position valuation.
- Artifact hashes, separate proof/data/model statuses and persistent experiment records.
- Research helpers for feature schema/fold binding, label maturity, model availability and evaluation roles.

Read [the model and proof contract](docs/CONTRACT.md) before interpreting results. Cash venues do not support margin or shorts; the derivative venue implements both under its declared model. OHLC interpolation, stops, market orders, amendments, rebates, external cash flows and corporate actions are unsupported. Unsupported event types and fields are rejected, not silently approximated. The research layer supports baseline ML training and validation search; its floating-point algorithms are tested separately from the Bend laws.

## Supply data

Download Binance ETHUSDT USD-M perpetual archives and their SHA-256 sidecars:

```powershell
npm run build
node scripts/download-binance.mjs 2026-09
```

Files are saved under `data/binance/um/ETHUSDT/2026-09/`, with a coverage and checksum `manifest.json`. The downloader tries monthly archives for all seven requested datasets, falling back to daily archives only on HTTP 404. Missing dates are recorded and an incomplete run exits with code 2. Rerunning rechecks existing ZIPs against current vendor checksums. Downloads remain `.part` files until accepted; ZIPs stay compressed.

`bend/Archive.bend` enforces nonzero exact byte length and equality of all eight SHA-256 words. Node handles HTTP, strict checksum filename parsing, streaming cryptographic hashing and file writes; those host operations are outside the Bend proof boundary. The archive policy is compiler checked and tested, but has no additional formal laws. `loadBinanceBars` now verifies and streams the small candle ZIPs directly, preserving exact units and declared coverage; `loadBinanceSeries` reads mark/index/premium prices and funding observations. The bar bridge converts candles only into an explicitly labeled cash-price proxy scenario. Bulk trades are not loaded by this adapter.

Copy `examples/demo.json`. All integer quantities, prices, timestamps and sequence numbers must be **decimal strings**, never JSON numbers. Every event has a unique `id`, globally increasing `sequence`, nondecreasing millisecond `time`, and the configured `symbol` and `currency`.

| Type | Additional fields | Meaning |
| --- | --- | --- |
| `submit` | `orderId`, `side`, `limit`, `quantity` | Reserve capital immediately; arrive after order latency |
| `cancel` | `orderId` | Request cancellation; release reservations at effective time |
| `tick` | `sourceTime`, `bid`, `ask`, `bidLots`, `askLots` | Fresh executable quote and replenished liquidity budgets |
| `clock` | none | Advance time and apply due cancellations without a quote |

Prices are quote minor units **per whole lot**. `lotSize` describes the underlying units in one lot; convert vendor prices and sizes explicitly upstream. `priceTick` is an integer price increment. `feePerLot` is quote minor units per filled lot. This model has no rounding: fractional lots, off-tick prices and noninteger monetary inputs are errors. Tick `sourceTime` must equal `time`; there is no delayed-feed model.

Quotes are executable model events, not guarantees that a real historical venue would give those fills. Each unique tick allocates its budgets once across all competing orders. Repeating the same ID is ignored; representing the same economic liquidity under different IDs is a dataset error outside the simulator's knowledge.

## Futures and perpetuals

`DerivativeExecutionVenue` supports linear and inverse/coin-margined contracts,
long/short targets, funding, margin checks, liquidation and dated expiry. It uses
the existing information/execution interface and experiment registry. Start with
`npm run derivatives-demo`; see [the derivative model and study guide](docs/DERIVATIVES.md)
for units, normalized data, validation/final-holdout workflow and model limits.
The existing ETH bar demo remains a cash-price proxy.

## Use the API

```js
import { Backtest, runStrategy, quoteInformationSource, QuoteExecutionVenue } from './src/index.mjs';
import { runExperiment } from './src/experiments.mjs';

const { result } = runExperiment('output/experiments', input.config, () => {
  const run = new Backtest(input.config);
  run.run(input.events.slice(0, 3));
  const saved = run.checkpoint(); // JSON-serializable, full event prefix
  return Backtest.resume(saved).run(input.events.slice(3)).report();
});

// Supply information and execution data independently, even for one market.
const source = quoteInformationSource({
  id: 'signal-market', instrument: input.config.instrument, ticks: signalTicks,
});
const venue = new QuoteExecutionVenue({
  id: 'execution-market', config: input.config, ticks: executionTicks,
  maxPositionLots: '1',
});
const simulated = runStrategy(source, venue, ({ history }) =>
  history.length === 1 ? '1' : null
);
```

`InformationSource` supplies market/features data. `ExecutionVenue` alone owns orders, fills, fees, funding, liquidity, margin and PnL. Strategies return target positions and receive immutable information history plus venue account state. Either adapter can be replaced independently; see [the adapter interfaces](docs/ADAPTERS.md). Quote/bar venues use the Bend cash model; `DerivativeExecutionVenue` adds its separately documented funding and margin model. Callbacks remain trusted JavaScript. Wrap research runs in `runExperiment`; the CLI does this automatically. Low-level engine calls are not automatically registered.

## Checks and proof boundary

`npm test` builds the engine and runs the E2E-first suite: ZIP ingestion through real strategy fills and immutable reports, separate rule/ML worker processes, optimized/reference replay, checkpoint restoration, malformed-data/tampering rejection, deliberate failing proof mutations and competing experiment processes. Downloaded-data checks run automatically when the September manifest is present. `npm run test:regression` retains the older focused accounting, numerical and policy checks. New behavior should be tested through complete workflows.

Build evidence is bound to hashes of the Bend sources and generated modules; stale builds cannot start a backtest. Provenance is captured for the loaded implementation and remains stable throughout a run. Builds hold an exclusive lock and reject source changes during verification. For large runs, use `runStrategy(source, venue, strategy, { lookback: 64 })` and configure the venue with `{ traceMode: 'compact', orderStorage: 'active' }`. The ETH bridge uses bounded history, compact recording and active storage by default, retaining all fills and final order records.

Measure complete workloads in fresh process groups:

```powershell
npm run benchmark -- --suite smoke-v1 --output output/memory/smoke
npm run benchmark -- --suite replay-v1 --ticks 250000 --repetitions 7 --output output/memory/replay
npm run benchmark -- --suite controls-v1 --ticks 250000 --output output/memory/controls
```

Use new output directories. The benchmark records preparation separately, observes
the supervisor and all descendants through reporting and registry publication,
and retains each repetition's plan, logs, timeline, phase memory and complete audit.
Windows uses a Job Object committed-memory high water; Linux requires delegated
cgroup v2 access and uses charged-memory high water. Sampled RSS/working set is a
separate explanatory metric. See [the benchmark guide](docs/MEMORY_BENCHMARK.md).
The [measured results](docs/MEMORY_BENCHMARK_RESULTS.md) record repeated
two-million-quote serial and five-worker runs on Windows.

For five concurrent tick workers sharing one admitted dataset:

```powershell
npm run benchmark -- --suite campaign-v1 --ticks 2000000 --workers 5 --jobs 5 --order-every 32 --node-options '--max-old-space-size=128' --output output/memory/campaign
```

This creates registered worker attempts, complete disk audits and a summary
with full-group peaks, run dispersion and exact ledger/trace identities.
Use `--dataset path/to/manifest.json` to reuse prepared quotes (also supply their
`--ticks` count). Keep `--jobs` fixed when comparing `--workers` concurrency.
Default event spacing is one millisecond; calendar coverage does not determine
tick capacity. The workload models top-of-book execution, not full depth/queue
matching. Larger information payloads and model-training memory need their own
capacity measurements.

Five-worker profiling on 2026-10-03 used Node 24.12.0, Windows x64, a Ryzen
7600X, 200,000 identical quote events per worker, 695 fills each, lookback 256,
and a 128 MiB V8 heap limit per process. These are single-run measurements;
campaign time includes workers, final reports and registry artifact publication,
but excludes shared input preparation:

| Implementation | Campaign seconds | Total audit MiB | Sum of worker peak RSS MiB |
| --- | ---: | ---: | ---: |
| Previous per-record storage | 32.4 | 723.2 | 1,456.9 |
| Compressed chunks and state reuse | 16.3 | 184.6 | 1,518.6 |

All five trace hashes, fill counts and ending ledgers matched exactly. The RSS
sum is a conservative sum of separate process peaks, not a sampled simultaneous
host peak. Storage savings depend on data entropy. Keep shared dataset files,
bounded callback history and summary reports; explicit full reports and array
inputs still require memory proportional to their history. See
[the storage and model limits](docs/ADAPTERS.md).

A larger synthetic tick campaign processed two million events per worker
(ten million total), with 62,500 fills per worker. All five completed in 167.1
seconds after 39.9 seconds of shared data preparation. The sum of worker peak
RSS was 1,528 MiB, shared data used 189.2 MiB, and complete audits used 1.89 GiB.
This validates event-count scaling under the same heap limit, not years of a
particular vendor feed. Full-depth payloads, price entropy and model training
can materially change throughput and storage. Size the campaign from the
actual event count and a representative prepared-data benchmark.

```powershell
npm run proof
```

This invokes `bend PROOF.bend --verdict` through the pinned compiler. The checked accounting and research-policy laws pass both the Bend compiler and the additional proof kernel on the current machine, using the downloaded Lean 4.34.0 toolchain. The Lean archive was checked against its release SHA-256; its version and digest are pinned in `toolchain.json`. The compiled kernel stays in `.tools/bendtt` and its binary hash appears in reports. Whenever project-local Lean is present, ordinary build/test/demo commands also run the kernel check automatically.

To reproduce the Lean setup on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-lean.ps1
```

On Linux x86-64, extract the official `lean-4.34.0-linux.tar.zst` archive into `.tools`, validate its digest from `toolchain.json`, then run `bash scripts/build-kernel.sh` and `npm run proof`. Without project-local Lean, an ordinary build performs compiler checks only and reports `kernel: not-checked`; an explicit proof run requires a working Lean toolchain or `BENDTT`. A failed build/proof command exits nonzero and invalidates old build evidence. The kernel build cache checks the compiler kernel source and built binary hashes.

Laws are in `LAWS.bend`; implementations are in `bend/Engine.bend`; proofs are in `PROOF.bend`. Review specification changes separately. No unsafe code, foreign functions or unfilled proof holes occur in the Bend module. The Node adapter, compiled runtime and economic validity of the quote model are outside the source proof boundary.

## References and versioning

The requested [bend2.dev index](https://bend2.dev/llms.txt) and its full corpus guided initial exploration. Implementation syntax and proof checking were verified against the [official Bend source and guide](https://github.com/bendlang/bend/tree/22ad9dc8325e963cf931e302c2218e27108046ff), pinned at 2.0.34. `toolchain.json` records the revision and backend. The local reference download and toolchain are ignored build dependencies, not framework source.
