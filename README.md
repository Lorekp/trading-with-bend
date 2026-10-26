# Trading with Bend

A research backtesting framework with a Bend cash-accounting and order-matching core, a Node.js replay and experiment layer, and an optional Python forecasting backend. It makes execution assumptions, data availability, experiment identity and the scope of verification explicit.

The project is a working reference simulator and research toolkit. Its formal laws cover selected accounting and policy properties; they do not establish realistic fills or profitable trading strategies.

## What it implements

- **Cash execution:** exact bounded integer accounting, capital and inventory reservations, FIFO limit-order matching, partial fills, shared quote liquidity, order/cancel latency and cancellation races.
- **Replay and audit:** validated chronological events, duplicate-delivery handling, independent ledger reconciliation, event-sourced checkpoints, immutable reports and source/data/configuration hashes. Large runs can use disk-backed audit storage and bounded strategy history.
- **Separate information and execution adapters:** strategies consume available observations and return target positions. Quote and completed-bar cash venues share this interface with a separate derivative venue supporting linear/inverse contracts, signed positions, funding, margin, liquidation and expiry under declared assumptions.
- **Research workflows:** causal trailing features, ridge/OLS baselines, purged walk-forward evaluation, comparable validation baselines and parameter search. Local campaigns freeze worker/input snapshots, retain the complete trial population, coordinate shared resource admission and control final-holdout release.
- **Optional forecasting:** zero-return, ridge, LightGBM and PyTorch TCN examples. Forecast accuracy and executable strategy returns are evaluated separately.

## Start with the synthetic example

Use a checkout of this repository and run commands from its root. The setup follows the committed scripts and CI configuration.

Requirements:

- Node.js **22.16.0 or later in the 22.x series, or 24+**, with npm; Node 23 is outside the supported engine range.
- Git and network access for the initial toolchain/dependency installation.
- Linux x86-64 with Bash, curl, unzip and checksum utilities; or Windows with an existing WSL distribution, defaulting to `Ubuntu-24.04`.

Linux:

```bash
bash scripts/setup.sh
npm run demo
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
npm run demo
```

The setup scripts run `npm ci`, check out the pinned Bend compiler, download a checksum-verified Bun binary into `.tools/`, and build the JavaScript modules. Windows compilation uses WSL; Node runs the generated JavaScript. Setup does not create the WSL distribution. Set `$env:BEND_WSL_DISTRO = 'Debian'` before setup/build commands if using another installed distribution.

`npm run demo` uses [examples/demo.json](examples/demo.json), requires no market-data download or Python environment, and prints the path of a uniquely named report under `output/reports/`. The fixture exercises buys, sells, partial fills and a cancellation race. Its results are synthetic accounting examples.

After building, run that input with an explicit report path:

```bash
npm run backtest -- examples/demo.json --out output/my-report.json
```

Choose a new output path: existing reports are not overwritten. CLI runs register their experiment evidence automatically; low-level API calls require an explicit experiment wrapper.

## Inputs and API

Copy the synthetic JSON fixture for a first cash replay. Its event types are `submit`, `cancel`, `tick` and `clock`. Integer prices, quantities, timestamps and sequence numbers are **decimal strings**, with prices expressed in quote minor units per whole lot. The host enforces the pinned backend's `2^48 - 1` bound on relevant values. Events must have nondecreasing timestamps and strictly increasing sequence numbers; the engine does not repair ordering for callers.

The public API is exported from [src/index.mjs](src/index.mjs). `Backtest` handles the validated cash event stream. `runStrategy(informationSource, executionVenue, strategy)` connects observations to a fresh execution venue; a strategy returns canonical target-lot strings or `null`. See [the adapter guide](docs/ADAPTERS.md) for complete examples and [the execution contract](docs/CONTRACT.md) for units, timing and checkpoints.

Additional examples:

```bash
npm run strategies-demo
npm run research-demo
npm run derivatives-demo
```

## Tests and formal checks

```bash
npm test
npm run test:regression
```

`npm test` builds and runs the end-to-end suite, including real compiled Bend modules, subprocess workers, replay/checkpoint checks, artifact-tampering rejection and deliberate proof-breaking mutations. The regression command runs the focused test files. Downloaded-data checks are conditional on the local September Binance manifest; a successful fixture suite does not establish vendor-data completeness.

[CI](.github/workflows/validate.yml) checks Node 22.16.0 and Node 24 on Ubuntu, installs the pinned toolchain and Lean kernel, then runs proof checks and both test suites. The [reviewed main-branch run](https://github.com/Lorekp/trading-with-bend/actions/runs/37204268397) completed successfully on both versions for commit `9c0879c`.

Ordinary builds check the Bend specification and record evidence in `build/verification.json`. For the additional proof-kernel check, Windows has a setup helper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-lean.ps1
npm run proof
```

On Linux x86-64, install the official Lean archive matching the version and SHA-256 in [toolchain.json](toolchain.json) under `.tools/`, then run `bash scripts/build-kernel.sh` and `npm run proof`. The CI workflow contains the exact download/checksum/extraction sequence. Without project-local Lean, ordinary builds record `kernel: not-checked`; explicit proof runs require a working kernel toolchain or `BENDTT`.

[LAWS.bend](LAWS.bend) specifies 32 accounting, cancellation, allocation, compaction, data-visibility and research-policy laws, with proofs in [PROOF.bend](PROOF.bend). Their scope matters: an accepted-admission branch preserving a ledger does not prove the risk predicate correct, and a bounded allocation primitive does not prove the whole matcher correct. Compiler translation, the generated runtime, Node/Python code, filesystem operations, vendor data and economic assumptions remain outside these source-level proofs. Integration tests and runtime checks address parts of those layers separately.

## Market data and research

Real-data studies require separately obtained and validated data. Downloaded archives, processed stores and local campaign outputs are not supplied by a fresh checkout. Start with [the market-data guide](docs/MARKET_DATA.md), then [the research guide](docs/RESEARCH.md) and [the derivative model](docs/DERIVATIVES.md).

The older ETH bar example described in [ETH_EXPERIMENTS.md](docs/ETH_EXPERIMENTS.md) requires the documented Binance data and uses perpetual prices as a **cash-price proxy**. It must not be interpreted as perpetual-futures execution evidence.

The [documented ETH intraday campaign](docs/ETH_INTRADAY_CAMPAIGN_2026_10_03.md) reports no acceptable strategy: all twelve base candidates and six stress candidates lost money after costs, and no final data was released. It used seven development days and synthetic bid/ask quotes derived from completed bars. The document links to ignored local evidence directories; the complete underlying artifacts are not part of the checkout, and the reported experiment has not been independently rerun here.

For optional forecasting, follow [FORECASTING.md](docs/FORECASTING.md). Its default demo uses deterministic synthetic data. Python 3.12 is the documented tested interpreter, with versions pinned in `requirements-ml.txt`:

```bash
python -m venv .tools/ml-venv
.tools/ml-venv/bin/python -m pip install -r requirements-ml.txt
export ML_PYTHON="$PWD/.tools/ml-venv/bin/python"
npm run ml-demo
```

Windows uses `.tools/ml-venv/Scripts/python.exe` and the PowerShell environment-variable syntax shown in the guide. These dependencies are optional for the cash demo and ordinary framework setup.

## Project layout

| Path | Responsibility |
| --- | --- |
| `bend/` | Pure accounting/matching engine, research policies and archive-admission primitives |
| `LAWS.bend`, `PROOF.bend` | Formal statements and implementations of their proofs |
| `src/` | Validation, replay venues, storage, provenance, studies and local campaigns |
| `src/ml/` | Optional Python forecasting implementation |
| `examples/` | Small API examples and JSON input fixtures |
| `experiments/` | Bounded research studies and speed/memory benchmark harnesses |
| `tests/` | Focused regressions and end-to-end workflows |
| `scripts/` | Toolchain setup, build, data processing and command entry points |
| `docs/` | Execution contracts, research protocols and documented results |
| `skills/` | Repository-specific guidance for assisted research workflows |

## Current limits

Each replay models one instrument. Cash venues do not support borrowing or short selling; the derivative venue is a separate single-instrument collateral model. Quote liquidity is supplied by the dataset/model, without a general exchange queue-position or market-impact model. The cash engine supports ordinary limit orders, not a general collection of market/stop/amendment order types.

Campaign coordination is local, cooperative and intended for trusted work. Shared admission budgets and V8 heap limits are not OS-wide CPU/RSS quotas. Filesystem-restricted workers are not hostile-code or network sandboxes. Holdout policies cannot prevent a trusted caller from directly reading outside data or choosing another authority directory. Multi-host execution is unsupported.

Checkpoints replay their saved event prefix rather than restoring in constant time. Disk checkpoints need their referenced audit files; strategy callback state is separate. Full-history reports and some optional ML paths can still use memory proportional to their inputs. Consult [the benchmark guide](docs/BENCHMARK.md) and [memory guide](docs/MEMORY_BENCHMARK.md) before extrapolating throughput measurements to another workload.

## Attribution and licensing

This repository contains the project-specific framework and integration work. Bend, Bun, Lean, Node.js and the declared JavaScript/Python dependencies are external projects; their respective licenses apply. [toolchain.json](toolchain.json) pins the Bend revision and toolchain versions. Research documentation records AI-assisted implementation and review.

The bundled [QuantConnect Writing Algorithms snapshot](docs/quantconnect-writing-algorithms/README.md) is third-party reference material, with its own source/provenance records. It is not this framework's implementation, and its presence does not imply QuantConnect affiliation.

No repository-wide license file was present in the reviewed snapshot. Do not infer an open-source license for the project or redistribution rights for third-party documentation from repository access alone.
