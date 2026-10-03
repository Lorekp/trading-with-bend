# Shared research toolkit

This toolkit supplies shared infrastructure for independent experiment agents.
Rule strategies and ML predictions emit target positions through independently
supplied information and execution adapters. The cash execution venues and
low-level `Backtest` use the Bend cash model. `DerivativeExecutionVenue`
adds linear/inverse futures and perpetual accounting through the same interface.
See [ADAPTERS.md](ADAPTERS.md) and [DERIVATIVES.md](DERIVATIVES.md).
A queue worker can also call another simulator, but its results then have that
simulator's verification boundary; the Bend proof claim does not transfer to it.

## Quick start

```powershell
npm test
npm run strategies-demo
npm run research-demo
```

The research demo launches six jobs with three concurrent worker processes:
buy-and-hold, two moving-average settings, mean reversion and two ridge settings.
They use the same synthetic dataset and validation window. Models use purged
training samples and one explicitly simulated millisecond of training/deployment
latency. All strategies pay fees and use executable limit orders. Reports include
open positions; no strategy is declared profitable based on this synthetic test.
Final holdout rows remain unused. Individual jobs save reports, split plans and,
for ML, model and regression artifacts in their attempt directories.

`output/research-demo` is durable. Repeating the demo with unchanged code/specs
reuses completed jobs. After editing shared code use a new registry/study identity,
for example `node examples/parallel-research.mjs output/research-demo-v2`.
Intentional identity collisions fail rather than silently replacing old evidence.

## Module map

| Module | Reusable tools |
| --- | --- |
| `src/core.mjs` | Pure integer validation, immutable views, errors, hashing and JSON; no compiled runtime required |
| `src/provenance.mjs` | Source snapshots shared by replay and experiment verification |
| `src/framework.mjs` | Exact event replay, ledger, fills and checkpoints |
| `src/information-source.mjs`, `src/replay.mjs` | Information observations and independent source/venue composition |
| `src/execution-venue.mjs`, `src/bar-execution-venue.mjs` | Venue-owned quote/bar execution, costs, liquidity and valuation |
| `src/derivative-data.mjs`, `src/derivative-execution-venue.mjs` | Normalized linear/inverse futures/perpetual data, signed positions, funding, margin, liquidation and expiry |
| `src/policies.mjs` | Bend-backed lot caps, data-role gates, label cutoff and deployment checks; exact affordable-lot division |
| `src/data.mjs` | Strict quote CSV ingestion, explicit units, chronology checks, deterministic synthetic fixtures |
| `src/strategies.mjs` | Target-position signals, buy-and-hold, moving-average crossover, mean reversion |
| `src/features.mjs` | Schema-bound trailing value/lag/mean/std/return features, batch/stream parity, warmup/missingness checks |
| `src/models.mjs` | Training-only standardization, ridge/OLS baseline, model/feature lineage, checked predictions and regression metrics |
| `src/sequence-data.mjs`, `src/forecast.mjs` | Regular sequence/label construction, optional Python model adapters, portable weights and checked return forecasts; see [FORECASTING.md](FORECASTING.md) |
| `src/evaluation.mjs` | Purged/embargoed walk-forward folds, persistent final-holdout release, regular return metrics, failure-preserving comparison |
| `src/search.mjs` | Bounded deterministic parameter grids, validation-only search jobs |
| `src/experiments.mjs` | Immutable manifests, atomic job claims, parallel processes, timeouts, logs, explicit abandoned recovery |
| `src/index.mjs` | Convenience exports of the shared public toolkit |

## Run multiple agents safely

Build once before starting a campaign. Each agent writes its worker under
`experiments/<agent-or-study>/` and enqueues uniquely named jobs into the same
local registry. The registry uses atomic hard links and requires a local
filesystem supporting them; network filesystem guarantees are not assumed.
Each attempt has a unique output directory and exclusive immutable publication.
Completed attempts record recursive artifact filenames and SHA-256 hashes, including
binary models. `readExperimentResult` and `verifyExperimentArtifacts` verify them.
Two runners can compete for the same key, but only one worker claims a generation.
Concurrency is a limit per runner, not a machine-wide quota.

```js
import { gridJobs, enqueueExperiment, runQueue } from './src/index.mjs';

const jobs = gridJobs({
  namespace: 'agent-a/trend-study-v1',
  workerModule: './experiments/agent-a/trend.mjs',
  baseConfiguration: { dataset: 'quotes-v3', datasetSeed: '41' },
  space: { fast: [3, 5], slow: [20, 40] },
  dependencies: ['./datasets/quotes-v3.csv'],
  maxTrials: 100
});
for (const job of jobs) enqueueExperiment('output/shared-registry', job);
await runQueue('output/shared-registry', { concurrency: 4, timeoutMs: 120000 });
```

The worker contract is ordinary trusted JavaScript:

```js
export default async function run(configuration, context) {
  // context: key, deterministic seed, attemptId, outputDirectory, writeArtifact
  const result = await yourStrategyOrTraining(configuration, context.seed);
  context.writeArtifact('model.json', result.model);
  return result.summary; // finite, acyclic JSON; decimal strings for exact money
}
```

Use the CLI from any agent:

```powershell
npm run experiments -- enqueue output/shared-registry jobs.json
npm run experiments -- work output/shared-registry options.json
npm run experiments -- status output/shared-registry
npm run experiments -- recover output/shared-registry agent-a/job-key
```

`options.json` contains `{"concurrency":4,"timeoutMs":120000}`. Every worker
records failures and exits, including crashes and timeouts. Recovery is explicit
and only succeeds after both worker and supervisor PIDs are dead on the original
host. PID reuse conservatively blocks recovery. Failed/completed jobs are never
automatically rerun; use a new key for a deliberate new trial. Recovery preserves
abandoned attempt records and advances the claim generation without deleting it.

`runExperiment` from `src/experiments.mjs` executes synchronous work using the
same immutable manifests, ownership claims, attempts, results and artifact
inventories as queued workers. Its callback receives `(configuration, context)`;
the configuration is a copy, and context supplies the same `key`, `seed`,
`attemptId`, `outputDirectory` and `writeArtifact` as a worker. It returns
`{ id, result }`, with `id` usable as the key for `readExperimentResult`,
`verifyExperimentArtifacts` and `recoverExperiment`. Results must be finite,
acyclic JSON. Use a queued worker for asynchronous work. Inline closure state
and external dependencies are caller-owned and cannot be reconstructed from
the manifest; the configuration must record the inputs needed to repeat a trial.

`listExperiments` and the `status` CLI read one population for both execution
modes, including running, failed and abandoned trials. Recovery checks recorded
process ownership in either mode. A dead inline owner's attempt becomes
`abandoned`; it is never queued because its callback exists only in memory.
Register a fresh inline trial to repeat it. Worker recovery still authorizes a
new attempt under the existing immutable specification.

The registry format is now version 2. Start a new registry for this toolkit
version; preserve older registries with their original checkout for inspection.
The root-level UUID record format and its special listing path have been removed.
CLI raw-input hashes and parsed input metadata are immutable attempt artifacts;
the full report is also retained as the verified result, independently of any
`--out` export.

Workers pin their entrypoint, declared dependencies, toolkit source/build hashes,
Node version and platform. Declare helper modules and datasets outside `src` as
dependencies; arbitrary transitive imports cannot be inferred reliably. The
runner checks before and after work and rejects drift. Do not edit shared modules
mid-campaign; use a separate checkout/version to develop the next engine.
Runtime/provenance hashes are integrity checks, not signatures or a malicious-code
sandbox. A trusted callback can still access files, the network or hidden data.
Timeouts bound waiting on inherited output pipes. Windows termination of descendants
that outlive an already-exited worker is best effort; worker code should own and
clean up any subprocesses it launches.

## Rules and prediction-to-order execution

`targetPosition(target, {maxPositionLots,warmup})` emits a target lot count or
explicit `null`. `target` is a decimal string or a callback of the frozen strategy
context. Built-in strategies require no venue fee configuration. `runStrategy`
accepts an InformationSource and ExecutionVenue separately; callbacks cannot
return submit/cancel orders.

The venue turns intent into feasible orders using its own prices, fees, liquidity,
capital and position cap. It cancels stale/conflicting orders, waits for effective
cancellation, and avoids stacking exposure. In-flight orders can still execute
during cancellation latency. Changing a cap cannot undo executed fills or
guarantee liquidation. Fee, funding, margin and PnL assumptions belong exclusively
to the selected venue. Source prices and volume are used only for signals.

Quote callbacks receive working orders only. Full order and fill audit records
remain available on the venue's backtest and in its reports and checkpoints.
Built-in quote strategies declare their required history as `strategy.lookback`.
`runStrategy` uses that bound by default (256 observations for undeclared custom
callbacks), and rejects an explicit smaller bound before reading any quotes.
Use `{ lookback: 'all' }` to request complete history explicitly. Custom callbacks
must declare or configure the history they need; use `tickCount` for elapsed
observations instead of `history.length`.

For build-independent data preparation, import `data.mjs`, `features.mjs`,
`numerics.mjs`, `search.mjs` or `core.mjs` directly. Registry inspection also
works without a build; enqueueing and executing experiments still require valid
runtime evidence. `index.mjs` exports the complete toolkit, including Bend-backed
modules, and requires a build.

## Data and features

CSV ingestion requires an explicit column map and units:

```js
const ticks = parseQuoteCsv(csv, {
  instrument: { symbol: 'XYZ', currency: 'EUR', priceTick: '1', lotSize: '1' },
  columns: { time: 'time_ms', bid: 'bid_cents', ask: 'ask_cents', bidLots: 'bid_lots', askLots: 'ask_lots' },
  units: { time: 'ms', price: 'quote-minor-per-lot', quantity: 'lots' }
});
```

No implicit sorting, rescaling, missing-value imputation, bar interpolation or
corporate-action adjustment occurs. See `QUOTE_UNITS` and the original model
contract. Synthetic quotes are deterministic fixtures, not calibrated markets.

Features declare ordered names, source fields, units and trailing definitions:

```js
const schema = [
  { name: 'return1', source: 'price', kind: 'return', lag: 1, unit: 'ratio' },
  { name: 'mean5', source: 'price', kind: 'mean', window: 5, unit: 'quote-minor-per-lot' }
];
const stream = new RollingFeatures(schema);
const feature = stream.update({ time: '100', availableAt: '102', values: { price: 1234 } });
// computeFeatures(rows, schema) uses the same streaming contract.
```

Warmup yields null feature entries and `ready:false`; inference rejects incomplete
features. Windows are trailing and include current data; labels remain separate.
Feature availability must not precede observation and must not decrease. A late
revision requires a new stream. External feature computation must adopt the same
schema contract; identical shapes alone are insufficient.

## Training and evaluation

`walkForwardSplits(samples, options)` takes chronological samples with unique IDs,
decimal-string `time` and `labelAvailableAt`. Optional `availableAt` or a nested
feature's `availableAt` controls delayed feature availability. The explicit
`finalStart` index reserves an untouched final tail. Training uses only rows whose
features and mature labels are strictly earlier than validation start minus the
embargo. Label maturity is checked per example rather than approximated by a gap.
Validation labels and features must also be available strictly before the first
final observation; excluded indices are recorded in each fold's
`validationPurged`. Validation windows do not overlap. Empty purged training or
validation folds are errors.

Use `foldRows(samples,plan,foldId,'train','train')` for fitting and
`foldRows(...,'select','validation')` for selection. It verifies the dataset hash
and regenerates the split plan to reject edited indices, then returns an immutable
partition artifact with `rows`, partition labels, dataset/plan hashes, a fold
identity derived from the plan, and cutoff. Pass this artifact as `training` to
`fitRidge({ training, schema, ... })` or `fitStandardScaler({ training, schema })`;
do not reconstruct its metadata or relabel its rows. Artifacts survive JSON
round trips and fitting rejects changed contents. Online training without a split
plan uses `trainingWindow(rows, { fold, cutoff })`, which explicitly records that
different origin and requires rows already marked `train`. Neither is an access
sandbox. `fitRidge` fits or accepts a scaler bound to the exact training artifact. Training
start, completion, deployment and decision times form an explicit availability
chain. The ridge objective is summed squared error plus alpha times squared
standardized coefficients; the intercept is not penalized.

`predictRidge` checks artifact content, schema order/units, fold, deployment and
feature availability, returning a hashed prediction. `evaluateRegression` never
fits and rejects training IDs or observations before cutoff. Its low-level
`partition:'final'` option is **not** a permanent release gate; use it inside
`withFinalHoldout` for a campaign's final evaluation.

`withFinalHoldout` consumes a persistent claim before exposing final rows. It is
single-use across processes for the dataset hash plus holdout ID, even when work
fails or the process crashes. Freeze the strategy hash and protocol before use.
Changing strategy parameters cannot recover that claim. Choosing another dataset
identity/holdout name or reading files outside the API is beyond its cooperative
permission boundary.

ML floating-point estimates and regression metrics are numerically tested, not
formally proved. Ridge/OLS is a small deterministic baseline with finite and
degeneracy checks; external ML frameworks can replace it through worker modules
while retaining data, artifact, execution and trial registration contracts.

## Reporting and verification

Accounting remains integer-based. `regularReturns` additionally computes a
numerical Sharpe only after the caller declares a regular interval and annual
frequency and every valuation passes that grid check. It explicitly uses zero
risk-free rate and sample standard deviation. Empty/constant return series remain
undefined. It omits the unsampled initial-to-first-quote period by convention.
`comparisonTable` preserves failed and invalid trials, orders them by ID and never
silently ranks final results.

Verification includes exact reference arithmetic, randomized execution, numerical
analytic examples, feature prefix/batch parity, tampered artifacts, delayed labels,
real competing worker processes, failure/timeout/crash handling, persistent final
release races and negative proof tests. Those negative tests intentionally ignore
fees, bypass caps or expose final/immature data and require the Bend checker to
reject each implementation. The new law scope is in `LAWS.bend`; filesystem
atomicity, foreign training and market validity remain outside formal proof.
