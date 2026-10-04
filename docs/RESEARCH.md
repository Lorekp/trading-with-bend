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
They use the same synthetic dataset and every validation fold. Models use purged
training samples and one explicitly simulated millisecond of training/deployment
latency. All strategies pay fees and use executable limit orders. Reports include
open positions; no strategy is declared profitable based on this synthetic test.
Final holdout rows remain unused. Each fold resets capital and supplies historical
observations for signal warmup without trading before validation. Every candidate
is compared with cash and buy-and-hold on the same data and execution model.
Individual jobs save complete studies, split plans and, for ML, a model and
regression artifact for each fold in their attempt directories.

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
| `src/study.mjs` | All-fold validation replay, history-only warmup, reset accounts, explicit equity sampling, baselines and population-preserving selection |
| `src/search.mjs` | Bounded deterministic parameter grids, validation-only search jobs |
| `src/experiments.mjs` | Immutable manifests, shared resource admission, continuous discovery, cancellation, telemetry, output limits and explicit dead-owner recovery |
| `src/campaigns.mjs` | Frozen campaign specification, search budget, complete trial membership, sealing and authoritative validation selection |
| `src/campaign-preflight.mjs` | Verified diagnostic reuse across capacity stops, immutable stop evidence and fresh checks before admission |
| `src/worker-bundle.mjs` | Verified toolkit/package snapshots, declared input copies and filesystem-constrained execution |
| `src/campaign-final.mjs` | Selected-artifact verification and canonical single-use final release |
| `src/study-cache.mjs` | Verified reuse of complete validation-fold artifacts across attempts |
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
`concurrency` limits each runner. A shared immutable `resourceBudget` limits all
runners using the same `admissionRoot`; the default admission directory is inside
the registry. Supply one absolute `admissionRoot` across separate registries when
they share a host budget. Every participant must use the same budget. This is
local-host orchestration; claims, process recovery and filesystem guarantees do
not support multi-host execution.

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
await runQueue('output/shared-registry', {
  concurrency: 4, timeoutMs: 120000,
  resourceBudget: { workers: 4, cpuThreads: 4 },
  idleMs: 1000 // Keep discovering arrivals until the registry is idle this long.
});
```

The low-level queue defaults to ordinary trusted JavaScript. For an official
multi-agent study, use the campaign module described below.

```js
export default async function run(configuration, context) {
  // Also reportProgress(json), heartbeat(), and previousAttempts.
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
low-level unfrozen runner checks before and after work and rejects drift. Frozen
workers instead execute their verified snapshots. Develop the next engine in a
separate checkout; running workers keep their admitted toolkit version.
Runtime/provenance hashes are integrity checks, not signatures or a malicious-code
sandbox. A trusted callback can still access files, the network or hidden data.
Timeouts bound waiting on inherited output pipes. Windows termination of descendants
that outlive an already-exited worker is best effort; worker code should own and
clean up any subprocesses it launches.

## Official campaigns

`createCampaign(root, specification)` is the module for coordinating independent
research agents. Its interface exposes `submit(job)`, `seal()`, `run(options)` and
`report()`, plus read-only `root`, `registryRoot` and `spec`. Reopening the same root
with the same specification is idempotent. Creation and inspection require no
compiled build; submissions require a verified runtime and installed packages.
The immutable event journal stores each admission once and reconstructs membership
on reopening. Concurrent submissions and sealing share one atomic publication
seam, with no leases or ownership stealing.

```js
import { resolve } from 'node:path';
import { createCampaign, releaseCampaignFinal } from './src/index.mjs';

const campaign = createCampaign('output/study-v1', {
  id: 'study-v1',
  datasetHash: preflight.datasetHash,
  planHash: preflight.planHash,
  comparisonHash: preflight.comparisonHash,
  protocol: preflight.protocol,
  maxTrials: 100,
  resourceBudget: { workers: 4, cpuThreads: 8, memoryMiB: 4096 },
  finalAuthorityDirectory: resolve('output/shared-final-authority')
});
campaign.submit({
  key: 'agent-a/ridge-alpha-1',
  workerModule: './experiments/agent-a/worker.mjs',
  dependencies: ['./experiments/agent-a/helpers.mjs'],
  configuration: { data: { file: resolve('datasets/validation.json') }, alpha: 1 },
  inputFiles: { '/data/file': resolve('datasets/validation.json') },
  resources: { cpuThreads: 2, memoryMiB: 1024 },
  seed: 41
});
campaign.seal(); // Close the search population; accepted trials still run.
const report = await campaign.run({
  concurrency: 4, timeoutMs: 120000,
  admissionRoot: resolve('output/shared-admission'),
  maxLogBytes: 1024 * 1024,
  maxArtifactBytes: 256 * 1024 * 1024,
  maxResultBytes: 8 * 1024 * 1024
});
const final = await releaseCampaignFinal(campaign, { samples, plan },
  (evaluation, { result, selection, readArtifact }) =>
    evaluateFrozenWinner(evaluation, result, selection, readArtifact));
```

Obtain `preflight` from `evaluateStudy` using the intended data, split plan,
protocol, baseline signals and execution assumptions. Its `comparisonHash` fixes
those comparisons before trials begin. A worker returns a complete validation
study directly or as `{ study, ...otherResults }`. The campaign supplies reserved
`configuration.campaign` metadata; callers cannot replace it. Every accepted key
counts against `maxTrials`, including failed, cancelled and abandoned work.
Identity collisions reject changes to configuration, seeds or frozen content;
use a new key for a changed trial. No caller supplies a replacement population.

`report()` includes all registered trials and their attempt histories. Official
selection remains `null` until the population is sealed and every admission has
registered and reached a terminal state. Completed results and supplementary
artifacts are verified, data/plan/protocol/comparison identities must match, and
selection uses `selectStudy`'s exact aggregate validation return and lexical tie
break. Completion publishes an immutable report; later recovery or artifact
mutation cannot silently replace its outcome. If a process exits after publishing
an experiment manifest but before binding admission, reopening recovers the
matching manifest without rereading the mutable checkout.

Campaign submissions always freeze the verified toolkit, installed locked package
contents, worker and declared helpers. Helpers must remain inside `sourceRoot`
(the toolkit checkout by default). External files use `inputFiles`: an explicit
JSON pointer must identify the matching string path in configuration. Only those
fields are rewritten to immutable copies; unrelated strings are preserved.
Dataset copies are reused by content identity across bundles in one registry.
Changes to original worker/helper/input files do not change queued execution.
Experiment admission owns input interpretation and the agreement between frozen
configuration, worker and dependencies. Campaigns reserve search budget only
after that admission succeeds; registration rechecks the captured evidence.
Callers enqueue source requests rather than supplying detached bundle descriptors.
Preserve the bundle and input stores with the registry; path descriptors alone
are not portable archives.

`workerIsolation: 'filesystem'` is the default. Node permissions allow reads of
the bundle, declared input snapshots and the worker's own job history, and writes
to its own attempt and claim directory. Undeclared final files remain unreadable.
Child processes, native addons and worker threads are unavailable in this mode.
Use a separately specified `workerIsolation: 'trusted'` campaign for Python or
other foreign training; its frozen provenance remains checked but its callbacks
have ordinary filesystem and process access. This restriction reduces accidental
filesystem access and is not a hostile-code or network sandbox. Never declare
final data as exploration input; files inside the final authority are rejected.
Permissions cannot detect final observations intentionally embedded in ordinary
configuration or declared input files. The trusted coordinator must prepare
train/validation-only payloads or fold artifacts. `evaluateStudy({ samples, plan, ... }, prepare)`
admits the supplied full sample collection and remains cooperative; giving a
worker full samples also gives it direct access to those rows despite role-gated
fold helpers. Keep sensitive final values with the coordinator.

`finalAuthorityDirectory` defaults to `.final-authority` beside the campaign
root. Campaigns in different parent directories or checkouts must explicitly
share the same authority directory. It cannot be the campaign root or live
inside the exploration registry. `releaseCampaignFinal` reopens the persistent
official report, verifies the winner and its artifact inventory, and derives the
claim from the dataset and actual final rows. Renaming a campaign or changing
training folds cannot grant another release of those rows at the same authority.
The trusted parent supplies final samples only to this callback; callback failure
or a crash still consumes the claim. The directory is a cooperative authority;
choosing a separate directory or directly reading data as a trusted caller remains
outside the contract.

## Operations, recovery and profiling

`queueStatus(registry, { admissionRoot })` reports live supervisors, durable
reservations and admitted worker/thread/memory totals. Each worker can call
`context.reportProgress(json)` or `context.heartbeat()`; the latest telemetry
includes a timestamp, PID and actual RSS. Progress must fit in 64 KiB and is
operational telemetry, not immutable research evidence.

Thread and memory declarations are admission estimates. The runner sets common
BLAS/OpenMP thread variables and bounds V8 old-space for declared memory. Native
allocations, child processes and total RSS are not OS quotas. Budget headroom for
supervisors, submitters, the controller and dataset/model preparation separately.
`maxLogBytes`, `maxArtifactBytes` and `maxResultBytes` default to unbounded;
configure them for demanding campaigns. Limit violations are recorded failures.
Artifact limits are checked on writes and by polling, so direct file writes can
temporarily overshoot; these limits do not reserve disk space.

`cancelExperiment` records queued or running cancellation in the population.
An abort signal stops new admissions; `shutdown: 'drain'` finishes owned workers,
while `'cancel'` cancels them. Other runners' workers remain owned by those
runners. Dynamic submissions are discovered while work remains, and `idleMs`
keeps a drained runner listening for the declared idle period.

After a supervisor interruption, verify that the recorded supervisor and worker
PIDs are dead. Call `recoverQueue(registry, { admissionRoot })` for the shared
admission directory, then `recoverExperiment(registry, key)` for unfinished jobs.
Admission recovery releases dead reservations; it does not rerun work, and job
recovery does not release reservations in an external admission directory.
Experiment recovery preserves abandoned history and authorizes a new generation.
Live owners and ambiguous PID reuse block recovery. Failed or completed jobs do
not automatically retry. Seal only when the accepted population and intended
recovery decisions are fixed.

For capacity stops after a completed diagnostic, use
`withVerifiedPreflight({ directory, identityHash, diagnostic, checkCapacity }, admit)`.
It never enqueues, reruns or recovers the diagnostic. On the first invocation it
pins its registry/key, specification/configuration, frozen bundle, attempt,
result and artifact inventory. Every invocation verifies those identities and
bytes, including frozen inputs and the bundle's Node/platform/architecture.
Queued, failed, abandoned and unfrozen diagnostics cannot be reused.

Compute `identityHash` from the current study/data/protocol and candidate
worker/helper/toolkit contents. A matching hash is the caller's attestation
that these are unchanged; the helper cannot inspect arbitrary closures or
discover undeclared candidate dependencies. Changed research identity needs a
new diagnostic and preflight directory. A revised capacity policy may reuse
the same diagnostic under the same research identity.

```js
await withVerifiedPreflight({
  directory: join(root, 'preflight'),
  identityHash: hash({ studyPlan, datasetHash, candidateSourceHashes }),
  diagnostic: { registry: diagnosticRegistry, key: diagnosticKey },
  checkCapacity({ job, result }) {
    // Measure now; include disk headroom, projected output and memory limits.
    const capacity = measureCapacity(job, result);
    return { ...capacity, allowed: capacity.projectedFreeBytes >= minimumFreeBytes
      && capacity.projectedMemoryBytes <= memoryBudgetBytes };
  },
}, ({ result }) => {
  const campaign = createCampaign(root, specificationFrom(result.study));
  for (const job of candidates) campaign.submit(job);
  return campaign.seal();
});
```

Each invocation publishes a new immutable `checks/<id>.json` before admission.
Denial raises `CAMPAIGN_CAPACITY`; a failed measurement records its error and
also prevents admission. The first denial is retained as `stop.json` and is
verified on subsequent invocations. `diagnostic.json` and the original stop
are never overwritten. Successful checks are not reusable authorizations:
the next invocation must measure again. Admission callbacks should use the
campaign's existing idempotent submission interface for restart safety.
This is cooperative orchestration, not a disk reservation or an accounting
change. Concurrent workers still require the shared queue admission budget;
capacity can change after measurement.

`evaluateStudy` can reuse complete validation folds through
`resume: { directory, preparationHash, previousDirectories }`. The preparation
hash must attest to callback/import contents, strategy/model configuration,
execution data/configuration and seeds; it cannot be derived from arbitrary
closures. Runtime, data, folds and protocol are independently pinned. Reused
folds verify their reports, metrics and referenced disk audits. Previous cache
directories are read-only; verified folds are copied to the current attempt's
writable directory. Preserve referenced audits. Use `context.previousAttempts`
to locate prior attempt outputs explicitly. This restores completed fold work,
not callback/model/RNG state or a partially completed fold.

Run `node --test tests/e2e/swarm.test.mjs` after building to exercise 34 short
synthetic trial jobs with independent submitters/runners, bounded shared
admission, dynamic arrivals, cancellation, failure, killed-owner recovery,
frozen edits, denied final reads and authoritative single-use final release.
It prints `SWARM_PROFILE` with elapsed time, journal size, sampled process RSS
and host used memory. Set `SWARM_PROFILE_PATH` to retain the JSON. RSS samples
are observations rather than OS peak measurements; host memory includes unrelated
processes. This acceptance scenario does not establish large-dataset training
capacity. Profile representative data and models before raising campaign budgets.

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

`createRidgePredictor({ model, schema, fold })` validates model/scaler hashes,
shapes, training IDs, lineage and chronology once, retaining a private immutable
copy. Its returned function accepts `{ feature, decisionTime }` and checks
feature hash, schema, readiness, finite values, deployment and availability on
every call. Admission takes O(training rows + feature count); each prediction
takes O(feature count), independent of training-history length. Mutating an
imported model or schema after admission cannot alter the predictor.
`predictRidge` is the one-shot form, including admission, returning the same
hashed prediction. Streaming callers should retain a predictor per fitted
model; evaluation and the walk-forward bar strategy do this internally.
`evaluateRegression({ model, evaluation, schema })` accepts the validation
artifact from `foldRows` directly. It verifies artifact contents, dataset, split
plan, fold and cutoff against the model, never fits, and rejects training IDs or
observations before cutoff. Decision times come from each row's `decisionTime`
when supplied, otherwise its feature's `availableAt`; deployment and feature
availability are checked for every prediction. Declare custom decision times in
the samples before creating the split plan, rather than modifying a partition.
Metrics retain the evaluation partition hash, dataset/plan hashes and, for final
evaluation, the release hash.

For online training, use `evaluationWindow(rows, { training })`, where `training`
is the exact `trainingWindow` artifact used to fit the model and rows are marked
`validation`. This binds evaluation to that training window without claiming
membership in a split plan. Split-trained models require split artifacts.

`withFinalHoldout` consumes a persistent claim before exposing a final partition
artifact to `(evaluation, claim) => result`. Pass `evaluation` directly to
`evaluateRegression`, or use `evaluation.rows` for another estimator. Final
partitions belong to the whole plan; ridge evaluation checks the model's dataset
and plan rather than requiring a validation-fold identity. Online models have no
plan to compare, so final evaluation enforces row exclusion and chronology and
records the released dataset/plan lineage without asserting shared study origin.
The gate is single-use across processes for the dataset hash plus holdout ID, even when work
fails or the process crashes. Freeze the strategy hash and protocol before use.
Changing strategy parameters cannot recover that claim. Choosing another dataset
identity/holdout name or reading files outside the API is beyond its cooperative
permission boundary.

ML floating-point estimates and regression metrics are numerically tested, not
formally proved. Ridge/OLS is a small deterministic baseline with finite and
degeneracy checks; external ML frameworks can replace it through worker modules
while retaining data, artifact, execution and trial registration contracts.

## Reporting and verification

`evaluateStudy({ samples, plan, protocol }, prepareFold)` owns the validation
loop. The callback receives `{ fold, training, evaluation, protocol }`; training
and evaluation are the verified artifacts from `foldRows`. It returns a
`strategy`, a `createReplay({ variant })` factory producing a fresh
`{ informationSource, executionVenue }`, and named `baselines` such as cash and
buy-and-hold. Optional `metadata` records fitted model or regression evidence.
The factory must use the same data, instrument, execution configuration and
model for candidate and baselines. It must create a fresh account every time.

Study admission takes an immutable snapshot of the samples and verifies the full
split plan once, before invoking any callback. Later folds use that admitted
snapshot, including across asynchronous preparation; mutating the caller's rows
or plan cannot change a running study. Standalone `foldRows` continues to verify
its inputs on every call. Samples and split indices still occupy memory: this
removes repeated admission work, not the need to bound the training population.

Fresh and reused completed folds pass the same Study admission before persistence
or aggregation: fold identity, baseline population, execution identity, replay
audits and metrics must agree. Fresh execution identities come from each actual
venue. The internal cache handles immutable storage and content collisions;
decoding a stored fold does not admit its research evidence.

The protocol is explicit:

```js
const protocol = {
  warmup: 'history-only', account: 'reset-per-fold',
  intervalMs: '60000', periodsPerYear: 365 * 24 * 60,
  maxStalenessMs: '60000'
};
```

Supply preceding observations through the information source when a signal needs
warmup. The runner accumulates their bounded history but does not invoke the
strategy before validation. Strategy callbacks must derive warmup from that
history; mutable callback state is not trained during warmup. No observation
after the evaluation endpoint is delivered. Accounts and strategy instances are
independent per fold. This policy does not simulate continuous cross-fold
positions or compounded deployment returns.

`sampleEquity(report, { startTime, endTime, intervalMs, maxStalenessMs })` samples
the last valuation at or before each grid point. The last record at a shared
timestamp wins; future records never fill earlier grid points. Both endpoints
must lie on the grid. Missing or stale samples, unmarked or nonpositive equity
inside the evaluation window, and deficit accounts are rejected. There is no
interpolation. File-recorded valuations are read incrementally. The resulting
sample array is proportional to the requested grid, not to market-event count.
`regularReturns` retains its stricter pure interface and never resamples implicitly.

Inside `evaluateStudy`, sampling and arithmetic-return calculation stream through
constant-size accumulators. Each fold's metrics retain `count`, `returnsHash`,
mean, sample variance and Sharpe, rather than the sampled-equity and return arrays.
Complete valuations remain in the report or immutable disk audit. The summary
uses Welford's online mean and variance; floating-point rounding can differ from
`regularReturns`' two-pass calculation. Its convention is recorded in
`metrics.accumulation`. Explicit `sampleEquity` and `regularReturns` calls still
return arrays when those individual values are needed. Market-event count and
sampling-grid length are separate scale measures; neither is inferred from the
calendar length of a study.

Study aggregation sums independent-fold P&L and divides by their summed initial
capital. It records exact rational excess returns against each baseline and
keeps per-fold numerical metrics; it does not splice fold equities or average
Sharpes. `selectStudy([{ id, status, study, error }])` selects the highest exact
aggregate validation return and breaks ties by trial ID. It retains failed,
abandoned and invalid trials, rejects mixed data/plan/protocol/execution identities,
and never selects from a final partition. Registry attempt records remain the
complete history of retried work. Release the chosen strategy only through the
existing `withFinalHoldout` gate; `evaluateStudy` never opens final data.

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
