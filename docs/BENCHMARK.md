# Design: execution speed benchmark

Status: the initial fresh-process comparison is implemented, following
[methodology research](BENCHMARK-RESEARCH.md). This document also records planned
extensions; measured results belong in each run's output directory. Scope is the
quote replay and experiment execution path. Bar strategies,
model training, derivatives and ingestion require their own declared workloads.

## The question and the primary measure

For identical admitted quotes, strategy decisions, execution assumptions and
required audit evidence, does a candidate complete a research job faster than a
baseline on this machine?

The primary measure is **fresh-process single-job completion wall time**. Existing
`runQueue` launches a fresh worker for each experiment, so natural startup, JIT and
GC costs belong in this measure. Required reporting and durable artifact
publication also belong in it. A replay that skips those obligations answers a
different question. The choice follows the representative-work and explicit-scope
principles in [the research](BENCHMARK-RESEARCH.md#define-the-claim-and-representative-work).

Publish milliseconds and a candidate/baseline time ratio for each workload.
Throughput is processed observations divided by the same scope's duration.
Do not describe it as exchange matching capacity or combine unrelated cases into
one speed score. These quotes exercise the declared cash-spot execution model;
they do not establish perpetual funding, margin or queue realism.

## Starting point

- The former `scripts/benchmark.mjs`, now `scripts/profile-replay.mjs`, performs
  one generated-quote replay. It separates
  preparation, replay, reporting and finalization, but rounds times to integer
  milliseconds, has no repeated comparison, and allows profiling during timing.
  Venue construction and source setup are included in its `replayMs`.
- `scripts/benchmark-campaign.mjs` and `experiments/scaling/worker.mjs` reuse
  admitted disk quotes, use the experiment registry, preserve audits, and report
  campaign timings. They measure capacity under configured contention. Worker
  timings exclude process startup; the campaign has no repeated paired estimate.
- The current constant-price fixtures compress unusually well. A fixed total
  `--orders` while increasing `--ticks` also reduces trading density. Neither
  dimension alone represents a general replay workload.
- `tests/e2e/optimized-replay.test.mjs` already checks active/all-order equivalence,
  compact/full trace semantics, admitted-data reuse, complete disk evidence and
  actual multiprocess campaigns. Reuse those verification conventions.

Historical timings in README and `docs/ETH_EXPERIMENTS.md` are explicitly single
measurements. Keep that qualification; this design cannot retroactively supply
their uncertainty.

## A deep module at the experiment seam

Keep performance machinery under `experiments/speed/`. The benchmark module
owns scheduling, process isolation, scope measurement, evidence validation,
statistics and report construction behind one interface:

```js
const result = await runBenchmark(protocol, {
  baselineRoot,
  candidateRoot,
  outputDirectory,
});
```

The protocol is plain JSON describing fixed work and measurement policy. The two
roots identify real execution adapters: independently built toolkit checkouts
that satisfy the same benchmark worker contract. Callers do not supply clocks,
profiler hooks, execution callbacks or an arbitrary timer lifecycle. A thin CLI
parses paths and invokes this interface; it contains no statistics.

Use a versioned suite and named measurement profile so callers do not
assemble timer policy themselves. For example, this input selects the
two quote cases and the provisional release defaults described below:

```json
{
  "schema": "speed-benchmark-v1",
  "suite": "quote-replay-v1",
  "profile": "release",
  "datasetSeed": 1,
  "scheduleSeed": 12345,
  "analysisSeed": 67890
}
```

Resolve it to explicit case configurations, input hashes, counts, repetition
budgets, timeouts, cache policy, runtime settings and decision rules before any
measured attempt. Save and hash that resolved protocol. A changed profile or
suite definition requires a new version; calibration produces a new resolved
protocol rather than changing defaults during measurement. CLI:

```powershell
npm run benchmark -- --protocol experiments/speed/quotes.json --baseline C:/bench/base --candidate C:/bench/change --output output/benchmarks/comparison-001
```

`experiments/speed/quotes.json` is the default protocol. `--profile smoke` uses
1,024 quotes and two pairs per case; `--profile pilot` uses 200,000 quotes and five
pairs. Both profiles are diagnostic and withhold performance conclusions.
The default release profile uses 200,000 quotes and twenty pairs. Omitting target
paths runs A/A in this checkout. Every run owns a fresh output directory. The
dataset seed must be nonzero, as required by the existing `syntheticQuotes`.

Compact input may also declare `pairs` and `timeoutMs` after calibration. Budgets
are fixed before measurement: 2..10,000 pairs (at least twenty for release), and
30,000..3,600,000 milliseconds per runner. For example, add `"pairs": 60` and
`"timeoutMs": 600000` to a release protocol after a separate pilot. Workload and
decision settings remain owned by the versioned suite.

`protocol.json` contains the reusable `speed-benchmark-resolved-v1` measurement
protocol. Pass it back with `--protocol` and a fresh output directory to repeat
the frozen settings. Modified suite fields and unknown fields are rejected.
`run.json` records host, roots, harnesses, schedule and admitted input identities
for that particular execution. Reports identify both the measurement protocol
hash and the run hash; raw sample arrays retain actual execution order.

The interface also requires immutable inputs, matching harness bytes, a new
output directory, and serial comparisons on one host. It returns a report and
publishes immutable raw evidence. Invalid configuration fails before measurement.
An execution failure returns an incomplete comparison with recorded attempts;
the CLI exits nonzero. Inconclusive timing with valid evidence is a completed
comparison, not an execution error.

Reuse `enqueueExperiment`, `runQueue`, `readExperimentResult`,
`verifyExperimentArtifacts`, `runtimeProvenance`, `hash`, `CanonicalArrayHash`,
`prepareQuoteData`, `openQuoteData`, `runStrategy`, `quoteInformationSource` and
`QuoteExecutionVenue`. Do not create a parallel ledger, recorder, scheduler or
registry. The worker remains `default async function(configuration, context)`;
it writes its report with `context.writeArtifact`.

This module has depth because deleting it would distribute measurement policy
and evidence checks across every workload. Locality comes from one implementation
of those rules. The changing toolkit is the real seam; a new plug-in interface
for every timer or statistic would add knowledge for callers without leverage.

### Execution across versions

Run a small benchmark-local runner in each target checkout, with that checkout
as its working directory. It enqueues one worker and drains its own fresh registry
with `runQueue({ concurrency: 1 })`. The outer benchmark module imports no target
toolkit into its own process.

`verifyExperiment` pins toolkit provenance. A registry created by the baseline
cannot execute the candidate under a different toolkit. Each target therefore
owns its registry and build, while both read the same immutable dataset.
Prepare both checkouts with the executing controller's identical benchmark harness
files before the run; refuse missing or differing harnesses, including two targets
that match each other but differ from the controller. Pin the controller at module
load and reject changes before or during a campaign. Each worker reports its
effective instrument, execution, history and recording settings; compare those
with the frozen protocol before accepting evidence. Applying the harness to an older revision
is an explicit preparation step, recorded in its source identity.

Build and verify each target once before measurement. Do not mutate sources,
rebuild, or run a competing registry supervisor during a campaign. Check dataset
format compatibility in preflight; incompatible readers require a separate
conversion/ingestion study rather than silently changing the shared input.

Use unique keys containing protocol identity, target identity, workload and pair
number. Declare harness helpers, protocol, dataset manifest and dataset file as
dependencies. Pass the workload seed explicitly: deriving it from a key containing
the target identity would give the versions different random inputs.

## Fixed workload matrix

Start with two controlled cases. Both use admitted disk input, complete disk
audits, compact traces, active orders, lookback 256, one-lot periodic round trips,
and summary reporting. Instrument, initial cash, fees, latency, quote freshness,
liquidity and callback behavior are identical across versions.

| Case | Work | Purpose |
| --- | --- | --- |
| `quotes-variable-dense` (primary) | 200,000 quotes; target opportunity every 32 quotes; seeded varying prices/sizes | Replay plus realistic variation in recording/compression work |
| `quotes-constant-dense` | Same count, density and execution settings; constant prices/sizes | Explain sensitivity to the existing highly compressible fixture |

The varying fixture is still synthetic. Its generator version, distribution,
seed, chronology and input digest are part of the protocol; do not describe it
as vendor-representative. Preflight must demonstrate both buy/sell fills and
nontrivial price/liquidity variation. Report actual targets, accepted events,
orders, cancellations and fills; requested targets are not necessarily fills.

The implementation reuses `syntheticQuotes`: initial bid 10,000, one-tick spread,
one-millisecond spacing, three-tick random-walk volatility and side depths sampled
in 1..100 for the variable case; zero volatility and fixed depth 100 for the
constant case. Its array construction happens only during untimed preparation.
The resolved generator identity plus harness and toolkit source hashes pin these
settings. Both variants use admitted streaming cursors for every timed replay.

Extend the suite after the first complete comparison works:

- Run 20,000 / 200,000 / 2,000,000 quotes at fixed opportunity intervals 32 and
  288. Keep the distribution and seed rules fixed. Report elapsed time, time per
  observation, audit bytes and lifetime worker RSS by size. Linear growth is an
  observation to test, not an assumed normalization.
- Add a fixed churning/partial-fill case that leaves working orders, triggers
  cancellations and exercises latency; adapt existing end-to-end scenarios.
- Add a pinned real-data snapshot with immutable file hashes and explicit
  information/execution assumptions. Use research-approved data, without
  opening a strategy study's final holdout to tune benchmark workloads.
- Add a five-worker campaign with equal work per worker to measure study
  throughput under contention. Its independent replicate is an entire campaign,
  not each of its five workers. Keep workload seeds identical across versions.

Reference `orderStorage: 'all'`, full trace, in-memory recording, full reports,
and unbounded history are separately named configurations. A different output
contract or callback history is a workload change, not a free optimization.
Explicitly bound expensive reference cases rather than selecting sizes after
seeing which version wins.

## Timing and isolation contract

| Measure | Start / stop | Included work |
| --- | --- | --- |
| `jobWallMs` (primary) | Outer monotonic timestamp immediately before runner launch / after successful runner close | Runner startup/imports, enqueue, worker startup and validation, input open, venue/source creation, replay, summary/seal, report artifact, registry result publication, process cleanup |
| `admissionMs` | Before `openQuoteData` / after it returns | Per-job admitted-data opening and checks |
| `setupMs` | After admission / immediately before `runStrategy` | Fresh venue, source and strategy creation |
| `replayMs` | Immediately before `runStrategy` / after it returns | Callbacks, execution, recording, target hashing and finish |
| `reportMs` | Before `report({ detail: 'summary' })` / after return | Report construction and audit sealing |
| `publishMs` | Before worker report artifact write / after it returns | Required report artifact write; excludes later registry publication |

The runner closes input and resources before exit. Parent validation and
cross-version stream hashing happen after `jobWallMs` stops. Normal hashing and
validation performed by production code stay inside their operation. Phase times
do not cover the entire primary scope; show unattributed startup/registry/cleanup
work without assigning it to replay. Do not derive primary time by adding phases.

Use `performance.now()` without rounding raw values. Capture phase CPU deltas
with `process.cpuUsage(previous)` in the actual worker. Parent CPU cannot stand
in for child CPU. Store units explicitly. [Node documents these timer and CPU
semantics](https://nodejs.org/api/perf_hooks.html#performancenow),
[including process CPU usage](https://nodejs.org/api/process.html#processcpuusagepreviousvalue).

No profiler, per-event memory sampling, forced GC or manual timer subtraction in
comparison runs. Retain ordinary JIT/GC and required I/O costs. Profiles are
separate diagnostic attempts marked ineligible for timing inference.

Read memory snapshots outside phase timing. `maxRSS / 1024` is lifetime worker
peak MiB, including startup, admission, reports and any warmup; it is not
replay-only memory. A heap snapshot is not peak heap or allocation volume.
Summing worker peaks gives an upper bound on their combined resident usage,
not a measured simultaneous host peak. [Node process resource
semantics](https://nodejs.org/api/process.html#processresourceusage)

The primary mode performs no discarded JIT warmup. A later sustained mode runs
fresh strategies/venues and unique audit directories for every iteration within
each process. Choose its discarded prefix from separate pilots, freeze it, and
retain the full ordered series. Describe throughput as after configured warmup;
do not claim steady state without supporting traces. Compute one mean per
process before comparison. [Warmup research and its limitations](BENCHMARK-RESEARCH.md#handle-jit-warmup-as-an-observed-property)

## Pilot, scheduling and host conditions

Provisional project defaults are five pilot pairs, then twenty measured pairs per
case, with a five-percent practical threshold. These numbers are design starting
points, not published universal rules. Use pilot variance, run duration and disk
space to choose a sufficient fixed measurement budget. A pilot that cannot resolve
five percent should increase repetitions or improve isolation before release.
Do not pool pilots into the measured population or stop when a favorable interval
appears. A CI smoke profile uses tiny fixtures and makes no speed claim.

Generate an equal number of AB and BA orders, shuffle with a recorded schedule
seed, and run each pair serially. Randomize the case schedule as well when there
are several cases. Each member uses a fresh process tree, registry and audit
directory. Balance odd budgets as closely as possible and disclose the imbalance.
Pair members use identical dataset and strategy seeds.

Pre-read the immutable dataset before each member outside timing, using the same
policy for both. Record this as `pre-read`, not guaranteed cache residency. Node
process state is fresh; OS/filesystem cache state is not. Never call this a
cold-disk benchmark. Any cold-storage study needs an explicit, independently
verified cache policy. Validate input identities before and after the campaign.

Use one quiet host on mains power with a consistent documented power mode.
Record OS, architecture, CPU model/logical cores, RAM, filesystem/storage location,
Node executable/version, V8 version, effective flags, heap limit, affinity and
cache policy. Record unknown host controls as unknown. Do not silently change
host settings. Record permitted performance-related environment variables, not
an unrestricted environment dump. In particular, registry workers currently use
`execArgv: []`: a parent CLI heap flag does not automatically reach workers.
Set and record a controlled `NODE_OPTIONS` for descendants and verify it there.

## Correctness gates and raw evidence

Before timing, run a small preflight through both real targets. After each timed
job, read the result through `readExperimentResult`, verify its artifacts and audit,
and compare canonical evidence. Reuse `CanonicalArrayHash` to stream large
histories; do not load full audits into memory to compare them.

Compare instrument/configuration, observed input and target identities, account
ledger/reservations, accepted event counts, execution status, fees/equity,
and canonical ordered events, final orders, fills and valuations. Require complete
audit evidence and the expected exercised paths. In the initial identical compact
configuration, compare `traceHash` too.

Allow differences only in a documented list of implementation provenance,
filesystem paths and storage representation. Keep the raw reports; never remove
all manifests or all assumptions to make comparisons pass. Compact and full
trace hashes intentionally differ because full traces include orders. Such a
comparison must check the declared projection of trace records as the existing
regression does. New schema differences require explicit review of equivalence.

Save a resolved protocol, both source/build/dependency identities, input identity,
scheduling seed, ordered samples with timestamps/PIDs/status, stderr/stdout,
phase metrics, reports, audits and their digests. Every failed, timed-out or
abandoned attempt stays in the population. Use fresh identities for reruns and
changed code; do not overwrite an old attempt or reclaim a live owner.

A missing/mismatching member makes its pair incomplete. Report all attempted and
completed counts. Withhold the workload's release conclusion if any measured pair
is incomplete; a complete-pair summary may be diagnostic and must say how much
is missing. Do not impute a timeout duration as a successful runtime or silently
drop slow observations. Timeout limits are fixed in the protocol.

## Comparison and decision rule

For complete independent process pairs `(B_i, C_i)`, compute:

```text
Q = arithmetic_mean(C_i) / arithmetic_mean(B_i)
speedup = 1 / Q
candidate time change (%) = 100 * (Q - 1)
```

For sustained mode, each `B_i` or `C_i` is its process mean. Do not average pair
speedups and do not count bars, fills or inner iterations as independent trials.
Resample whole pairs with replacement 10,000 times using a recorded analysis
seed; recompute Q for each draw and report its 2.5th/97.5th percentile interval.
This is a paired adaptation of the [hierarchical effect-size
methodology](https://arxiv.org/html/2007.10899); it is an approximate interval,
conditional on these workloads and sufficiently independent process pairs.
It does not quantify uncertainty across arbitrary hardware or market histories.

For the predeclared primary case, apply the practical threshold to the Q interval:

| Entire interval | Conclusion |
| --- | --- |
| Below 0.95 | Improvement of at least the declared practical size |
| Above 1.05 | Regression of at least the declared practical size |
| Within [0.95, 1.05] | Change bounded within the declared tolerance |
| Anything else | Inconclusive |

Show baseline/candidate means, standard deviations, medians and all raw points
in run order, plus Q and its interval. Do not use the fastest run as the headline
or present p95 latency from twenty jobs as a reliable tail estimate. Inspect AB/BA
effects and drift; unexplained sustained drift requires another controlled run,
not an interval calculated as though it disappeared.

The resolved protocol predeclares conservative diagnostic screens. Compute Q
separately for AB and BA pairs and flag an absolute `Q_AB / Q_BA - 1` above five
percent. In actual sample order, compare equal-sized early and late halves of
complete pairs for each target; flag an absolute late/early mean change above five
percent. Odd populations omit the middle pair from these drift windows. Each order
group and drift window needs at least two pairs. Publish the groups, window means,
ratios, thresholds and all issues. These are project screening rules, not a test
that establishes independence or detects every form of drift.

A complete release comparison with any diagnostic issue is `requires-review`,
ineligible for inference, and retains its ratio and interval as diagnostic output.
Investigate host conditions and repeat a separately frozen campaign; there is no
override that promotes the suspect population to a release conclusion. Smoke and
pilot remain diagnostic even when these screens pass.

Secondary cases have descriptive intervals and separate conclusions. There is
one frozen primary case; no all-suite significance claim or multiple speed gates
is justified by these individual intervals. Establish a dedicated runner's noise
floor and an A/A comparison before adding a performance gate to CI. Ordinary CI
checks execution, completeness and correctness without a wall-time threshold.

## Implementation sequence and verification

Steps 1--3 are implemented for the initial two fresh-process cases. Warmed
throughput, larger scaling cases, vendor snapshots and campaign contention are
extensions, not modes exposed by the current comparison command. Profiling remains
available separately through `scripts/profile-replay.mjs`.

1. Add `experiments/speed/worker.mjs`, its local runner, the benchmark module and a
   small fixed protocol. Implement one fresh-process disk case end to end, using
   the existing registry. Replace the single-shot `scripts/benchmark.mjs` entry
   with the thin protocol CLI; preserve profiling as an explicitly separate
   diagnostic mode, and update its documented invocation in the same change.
2. Add the constant/variable cases, paired scheduler, immutable sample records,
   stream-equivalence gate and pure statistical summarization behind the module.
   Store results under a fresh `output/benchmarks/<run-id>/` directory.
3. Add a small A/A workflow to `tests/e2e/optimized-replay.test.mjs`: both targets
   can be the same checkout but require distinct process attempts/registries.
   Verify pair order, identical seeds/evidence, fresh venue/strategy state, raw
   precision, publication, and report completeness. Inject a real failing worker
   and dataset dependency change to prove no speed conclusion survives failure.
   Test the internal statistics seam with known synthetic pair records, including
   a constant ratio and correlated pairs; no elapsed-time assertions.
4. Run `npm test` and `npm run test:regression` for the implementation, since it
   extends research execution tooling. Run five-pair pilots on the target host,
   freeze the final protocol, and measure the fixed paired population.
5. Extend to scaling, representative snapshots, sustained replay and campaign
   contention only after the initial evidence pipeline works. Reuse the existing
   campaign path for capacity diagnostics; factor shared workload construction
   into benchmark-local helpers when two callers actually need it.

Acceptance requires a reproducible report from the saved protocol and samples,
verified equivalent complete evidence, every planned attempt accounted for,
and an interval/conclusion consistent with the declared decision rule. Faster
timing by itself is insufficient.
