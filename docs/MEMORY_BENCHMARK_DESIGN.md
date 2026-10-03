# Memory benchmark design

Status: design reference. The execution benchmark is implemented; see
[the running guide](MEMORY_BENCHMARK.md) for available suites and remaining extensions.
Researched on 2026-10-03. Read [the primary-source research](MEMORY_BENCHMARK_RESEARCH.md)
for measurement definitions and supporting evidence. Sizes, repetition counts,
sampling intervals and gates below are project decisions, to be calibrated in a pilot.

The benchmark should measure the memory needed to complete a correct demanding
workload, from process startup through durable result publication. Use a fresh
process group for each repetition, an observer outside that group, and a platform
memory high-water counter. Add a sampled timeline and phase-local Node snapshots
to explain the result. Keep capacity, retention and throughput as separate results.

## Questions the benchmark must answer

1. How much memory does a complete replay or campaign require at a specified scale?
2. How does demand change with events, order activity, working orders, history,
   report detail, model dimensions and worker concurrency?
3. Which phase causes the increase: admission, replay, reporting, serialization,
   model training or artifact verification/publication?
4. Does repeated work in one process retain additional memory after references
   are released? Does a workload complete correctly under an explicit memory budget?

An end-of-run heap reading cannot answer the first question. A sum of worker
high-water values cannot establish a simultaneous campaign peak. A small synthetic
replay cannot establish the memory cost of a Python-backed forecasting study.

## Starting implementation and reusable modules

| Existing code | What to reuse or change when implementing |
| --- | --- |
| `scripts/benchmark.mjs` | Deterministic quote fixture and configurable lookback/trace/order storage. Replace its ad hoc measurement flow: it has initial, replay and final snapshots; optional forced GC; a rounded process RSS high water read before output serialization; no repetitions or external observer. |
| `scripts/benchmark-campaign.mjs` | Shared admitted dataset and real queued workers. Its `aggregatePeakRssUpperBoundMiB` is explicitly an upper bound, omits the supervisor, and is not a measured campaign peak. Replace campaign measurement with the same benchmark module used for serial runs. |
| `experiments/scaling/worker.mjs` | Disk data/audits, bounded callback history, compact reporting and correctness fields. Extract/reuse this workload rather than implementing another replay. Its high water is read before registry artifact inventory and final result publication. |
| `src/experiments.mjs`, `src/experiment-worker.mjs` | Immutable specifications, attempts, failure records, subprocess execution and artifact checks. Keep these as the execution and provenance mechanism. |
| `src/quote-data.mjs`, `src/recording.mjs` | Admitted bounded-cursor quotes, indexed SQLite recordings, sealed audit manifests and streaming audit reads. |
| `src/replay.mjs`, `src/framework.mjs`, `src/study.mjs` | Synchronous replay, exact accounting, checkpoints, report detail and study metric accumulation. Exercise their existing interfaces. |
| ETH and forecast workers; `src/forecast.mjs` | Representative archive/ridge workloads and optional Python model fitting. Forecast fitting creates matrices and JSON in Node and calls `spawnSync`; include both processes. |
| `tests/e2e/optimized-replay.test.mjs` | Existing exact replay/storage/report/checkpoint and five-worker constrained-heap checks. Extend this test home for benchmark end-to-end checks. |

`runQueue` forks workers with `execArgv: []`: passing a heap flag only to the
supervisor does not configure its workers. Pin and verify inherited `NODE_OPTIONS`
for benchmark runs. A V8 heap limit is distinct from a process-group memory budget.
Existing queue termination has documented limitations for Windows descendants;
the benchmark must own its group through the last descendant's exit.

## Measurement contract

Store integer bytes and monotonic nanoseconds in raw results; nanoseconds use
decimal strings in JSON. Convert to MiB and milliseconds only for presentation.
Every metric records its scope, source and whether it is a lifetime high water,
sampled maximum, phase snapshot or diagnostic. Missing measurements are null with
a reason, never zero. Keep absolute demand; baseline differences are supplementary.

| Metric | Meaning and limitations |
| --- | --- |
| Linux `groupChargedPeakBytes` | Fresh cgroup v2 `memory.peak`: workload and descendants' charged memory, including relevant file cache and kernel memory. Primary Linux capacity result; not RSS. Record swap separately. |
| Windows `groupCommittedPeakBytes` | Fresh Job Object `PeakJobMemoryUsed`: job committed-memory high water. Primary Windows capacity result; not resident working set and not Linux cgroup accounting. |
| `sampledTreeResidentPeakBytes` | Maximum observed aggregate process RSS/working set at a sampling tick, including supervisor and descendants. Sampling can miss spikes; shared pages can be counted more than once. |
| Per-process resident high water | Node `resourceUsage().maxRSS * 1024`, or native OS counter, with its coverage interval. A worker self-report before returning covers only that prefix, not publication or the whole campaign. |
| Phase Node memory | `rss`, `heapUsed`, `heapTotal`, `external`, `arrayBuffers` at named phase transitions. `arrayBuffers` is included in `external`; never add them together or add them to RSS. These are snapshots, not heap peaks. |
| Secondary cost | Wall time, processed events/orders/fills, completed jobs, audit/dataset bytes, paging/swap and observer cost. Required to expose memory reductions obtained by slowing down or omitting work. |

The measured resident aggregate is `max over sample ticks of sum of live-process
resident readings`. Readings within a tick are sequential, so record tick duration
and skew. Do not call this an exact instantaneous physical-memory total. Linux
PSS from `smaps_rollup` can be collected in a slower diagnostic run to investigate
shared-page accounting; it is not the normal high-frequency measurement.

Neither group counter defines an exact phase peak. Associate timeline samples
with phase intervals and label maxima as sampled; retain the lifetime counter
for full-workload capacity. A late phase notification or a sampling gap must
remain visible. Subtracting two lifetime high waters is not phase allocation.

These distinctions follow [Node's memory definitions](https://nodejs.org/download/release/v22.16.0/docs/api/process.html#processmemoryusage),
[Linux cgroup accounting](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
and [Windows job memory accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information).

## A deep module at the benchmark execution seam

Keep one caller-facing module outside the trading toolkit, under
`experiments/memory/benchmark.mjs`, with this interface:

```js
const result = await runMemoryBenchmark(plan, { outputDirectory });
```

`plan` is finite JSON: a version, suite/catalog version, fixture references,
repetitions, order seed, timeout, explicit runtime settings and optional group
budget. Named suites expand to a frozen list of cases before execution. Reject
unknown fields, incompatible fixture counts and unavailable required collectors
before launching work. The output directory must be new; publication is exclusive.
Return a compact JSON summary containing every planned attempt and artifact paths.
Partial operational failures produce a failed summary and a failing CLI exit code;
invalid plans or inability to create the output directory fail before execution.

Implemented serial-replay caller example:

```js
await runMemoryBenchmark({
  version: 1,
  suite: 'replay-v1',
  ticks: 2000000,
  datasetManifest: './output/fixtures/quotes-2000000/manifest.json',
  repetitions: 7,
  orderSeed: 41,
  timeoutMs: 3600000,
  runtime: { nodeOptions: '--max-old-space-size=2048' }
}, { outputDirectory: './output/memory/replay-study-001' });
```

The interface includes the full-lifetime scope, natural-GC policy, platform metric
semantics, immutable outputs and completion requirements. The implementation owns
case expansion, provenance, process containment, sampling, failure capture,
correctness verification and aggregation. Removing this module would spread those
responsibilities across every benchmark caller: it passes the deletion test.

Use two real internal collector adapters, Linux cgroups and Windows Job Objects,
at the group-launch/observe/terminate seam. Keep collector operations private;
callers need no PID registration, GC hooks, start/stop ordering or memory provider.
Accept the explicit runtime/output dependencies above rather than selecting an
unrecorded Python executable or global output path. Reuse real OS collectors in
integration tests; no general plugin framework or public mock interface is needed.

The external driver stays outside the measured group. The group contains a fresh
Node supervisor, its queued workers and their ordinary descendants. The supervisor
uses `enqueueExperiment`/`runQueue`; workload workers keep the established default
async `(configuration, context)` interface and use `context.writeArtifact`.
Measurement logs belong to the outer driver, because they continue after worker
publication and must survive worker failure. Bind their final hashes to the
benchmark summary, separately from the registry's immutable attempt artifacts.

At implementation, make `scripts/benchmark-memory.mjs` the thin CLI for this module,
remove `scripts/benchmark-campaign.mjs`, and update its existing test and documented
invocations. Move the reusable scaling workload/helpers into `experiments/memory/`
and remove the obsolete worker. Keep one measurement path rather than retaining
two reporting formats or adding compatibility modes. Shared toolkit code needs
no new measurement hooks.

## Process lifetime and phases

1. Verify a completed build and fixture identity; freeze the expanded plan and
   host/runtime metadata. Builds and downloads are outside measured replay cases.
2. Create a fresh group and prepare the external observer. Start the supervisor
   inside containment before application code can allocate or fork. Measure from
   startup, including module imports and registry setup.
3. Enqueue immutable case/repetition specifications in a fresh registry. Register
   dataset, worker helpers and external model files as dependencies. Keys include
   case/configuration identity, repetition and candidate identity; never reuse
   completed jobs as another measurement or rerun a changed specification.
4. Workers emit small phase records at entry/exit, with monotonic timestamps,
   PID and `process.memoryUsage()`. Use fixed-count records or a bounded stream;
   no growing in-memory sample array and no per-event measurement callback.
5. Execute admission, replay/fit, report/seal, artifact serialization/write,
   cleanup, then registry inventory/result publication. The observer continues
   through supervisor result verification and exit and until the group is empty.
6. Read the group's final high water and failure counters before removing it.
   Verify correctness artifacts, publish the outer attempt record, then summarize.

Phase timing uses emitter timestamps, not arrival times. Use a supervisor clock
handshake to estimate cross-process offsets/skew; if alignment cannot be
established, keep per-process phases without assigning group samples to them.
The group lifecycle establishes full-run duration independently of phase messages.
Allow a bounded final-record flush; do not trust an IPC send immediately followed
by `process.exit`. Group high water must still be available if no message arrives.

On Linux, launch through a minimal contained launcher that joins the fresh cgroup
before executing Node; do not move a running replay into it later. Keep the driver
outside, require delegated controller access, and refuse official capacity runs
when it is unavailable. Record cgroup/kernel features and `memory.events` deltas.
Use a new cgroup per attempt instead of relying on version-dependent peak resets.

On Windows, use a small local launcher/collector helper: create Node suspended,
assign it to a fresh Job Object, then resume it. Disable breakaway, retain the job
handle through descendant exit, and use job termination for timeout/cancellation.
Establish completion by checked active-process accounting; root exit, a Job
notification or waiting for the Job handle alone does not establish an empty job.
See [Microsoft's job lifecycle documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects#resource-accounting-for-jobs).
Record helper source/binary identity and required OS capabilities; nested-job or
assignment failure is an unsupported collector result, not a silent PID fallback.
Do not start one PowerShell process per sample. Build the helper outside measurement;
keep its implementation restricted to documented job/process accounting operations.

If an OS high-water collector is unavailable, an explicitly requested diagnostic
run may use external sampling and Node snapshots. Mark it as diagnostic with
incomplete peak coverage and exclude it from capacity comparisons and gates.

## Workload catalog and scales

Use controlled scaling to expose growth and real data to confirm relevance.
Freeze each fixture's seed, hash, event/window endpoints, instrument and economic
assumptions. Do not duplicate an archived month to pretend it is a longer history.
Vary one axis at a time before selecting a few combined stress cases; avoid a
Cartesian product of every storage, model and concurrency option.

| Family | Frozen cases and purpose |
| --- | --- |
| Harness smoke | 1,307 quotes, order interval 32, 1 and 2 workers, 2 repetitions. Matches the existing campaign test's fixture scale. Verifies machinery only. |
| Replay scaling | 250,000, 1,000,000 and 2,000,000 quotes; one worker; disk data/audit; lookback 256; active orders; compact trace; summary report; order interval 288. Include admission, sealed report and publication. |
| Order churn | 250,000 quotes, intervals 288, 32 and 2. Separate a deterministic direct-`Backtest` workload with 1, 64 and 512 working orders, constrained liquidity, partial fills and cancellations. Provision sufficient valid capital/inventory and independently check counts/FIFO/reservations. Historical order count and concurrently working order count are different axes. |
| Storage/history controls | Same 250,000-quote decisions for memory versus disk data, memory versus disk audit, and lookback 256 versus all. Change one setting at a time; strategy must not depend on truncated history. Full trace/all-order matching controls start at 2,000 and 10,000 quotes under a frozen timeout/budget rather than expanding a potentially quadratic case to millions. |
| Reporting and restore | Disk replay at 250,000 and 1,000,000 quotes, summary versus explicitly full report plus serialization. Separate fresh-process checkpoint restoration at 25%, 50% and 100% of a pinned prefix with deterministic continuation. This measures materialization and O(history) restore, not just replay. |
| Concurrent campaign | Shared 2,000,000-quote admitted fixture; fixed five-job population at concurrency 1, 2 and 5, identical job configurations/seeds and new audit per job. Group includes supervisor. Record actual worker overlap rather than assuming the requested concurrency was sustained. Add a small mixed rule/ridge campaign later to exercise overlapping phases. |
| Validation study | `evaluateStudy` with verified train/validation artifacts, fixed model window, 2 and 8 folds and independently varied valuation-grid sizes. Measure sample/plan admission, fitting, streamed metrics, retained fold reports and final study serialization. No final holdout release. |
| Real archive study | Pinned September ETH fixture and the existing rule and trailing-ridge workers/windows. Include archive verification/decompression and model artifact writes. Declare the cash-price proxy and its bar assumptions; make no perpetual funding/margin or investment claims. Missing archives are recorded as unavailable cases. |
| Optional forecast | Reuse `ethForecastData`/`sequenceSamples` and `fitForecast`, CPU only: 4,000, 16,000 and 64,000 synthetic rows at 60 observations x 6 features; then available real windows. Zero/ridge first, LightGBM/TCN only with a pinned environment. Include Node matrices/JSON, Python allocations, model/result parsing and publication. Record BLAS threads, training parameters, seed and train/validation partition hashes. |
| Retention diagnostic | One worker performs 20 fresh replay/report/cleanup cycles at fixed 25,000-quote scale. Release large references between cycles and persist each audit rather than keeping reports in an array. Plot post-cleanup snapshots; repeat in a separate forced-GC diagnostic process. A slope suggests retained growth, not a proved leak. |

The primary demanding suite initially comprises replay scaling and the campaign
cases above. One replay and five sequential campaign jobs are distinct cases;
changing concurrency keeps campaign work fixed rather than also changing job count.
Run heavier reporting, models and retention as named suites with separate results.
These are fixed-work cases: all planned work must complete. Record requested and
actual observations, events, submissions, fills, cancellations, working-order
maximum, fits, folds, model dimensions and audit bytes. Distinguish one immutable
fixture's full size from each case's prefix; manifests record both hashes/counts.

Pre-admitted replay and dataset preparation are distinct cases. Measure
`prepareQuoteData`/archive processing from raw input in its own fresh group,
including sealing and validation. Preparation outside a replay case does not
make dataset preparation free; report both costs without summing unrelated peaks.

## Repetition, GC, cache state and overhead

Capacity runs start cold in a fresh process and use natural GC. No `--expose-gc`,
forced collections, profiler or heap snapshot in the primary plan. Do not discard
startup/warmup memory. A pilot validates fixtures and collector operation; it is
recorded as a pilot and never selected as the best measured result. A steady-state
retention run is a separate experiment with its own warmup/cycle protocol.

Start with seven fresh-group repetitions per demanding case, serially scheduled
except for concurrency explicitly inside a campaign. Use a saved random order
across cases. For candidate comparisons, run baseline and candidate in randomized
paired blocks on the same host, with identical fixtures, flags, budgets and cache
policy. Freeze the pair count before inspecting results; extra investigation is a
new identified study, not selective reruns replacing unfavorable observations.

Default filesystem state is ordinary warm-cache operation after a declared fixture
validation pass, with actual cache residency unverified. Do not claim cold-cache
results or flush machine-wide caches. Separate first-read/cold-cache experiments
need an independently specified host/cache protocol. Record filesystem/storage,
fixture access order, available physical memory, swap/pagefile settings, host load,
OS/kernel, CPU, Node/V8, Python packages, runtime flags and helper versions.
Linux page-cache charges may belong to the cgroup that first instantiated a page,
so shared warm input cache is not necessarily charged to each worker's fresh group.
Record sampled `memory.stat` anonymous/file/kernel categories and the fixture
pre-read policy; investigate attribution before calling a charged-peak change an
application allocation change. Treat free RAM and swap pressure as experimental
conditions, not a subtraction from the measured peak.
See [Linux memory ownership](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#memory-ownership).

Begin external resident sampling at 50 ms. Record actual intervals, sample count,
largest gap, sample duration/skew, coverage and observer CPU/memory. Stream
timestamped samples to bounded buffers on disk. Calibrate overhead using paired
representative runs with high-water collection only and with timeline sampling at
10/50/200 ms; choose/freeze the least intrusive useful interval. A provisional 2%
runtime overhead target requires repeated evidence. If exceeded, publish the
high-water-only result and reserve the timeline for a diagnostic study.

## Correctness, artifacts and failed attempts

Use existing end-to-end reference replays to establish oracle fixtures before
memory comparisons. Each measured attempt must independently satisfy expected
counts, exact terminal cash/inventory, reservations and canonical execution-stream
hashes. Stream full disk audit verification; avoid loading every fill just to
verify a capacity result. Include ordinary registry inventory/result checks inside
the group; heavyweight independent oracle verification may run outside it after
exit and is explicitly excluded from the measured lifecycle.

Require exact trace hash equality only when trace semantics match. Full versus
compact traces intentionally differ; compare exact orders, fills, valuations,
ledger and signals instead. Reporting/storage changes must preserve the declared
economics and full audit availability. Model comparisons use frozen numerical
tolerances and lineage checks, not exact equality of environment-sensitive floats.

Each outer attempt records plan/specification hashes, source/build/worker/helper
hashes, fixture/dependency identity, host/runtime details, order and seeds, registry
attempt IDs, process-group identity, measurement method, phases, timeline hash,
exit status/signal, correctness status and peak coverage. Retain logs and partial
audits for every failure; never seal an incomplete audit as a valid report.

Use a versioned outer record with a common envelope and named metric descriptors,
rather than a generic `peakMemory` field. Illustrative shape (values are placeholders):

```js
{
  format: 'memory-benchmark-attempt-v1',
  caseId, repetition, specificationHash, registryAttemptIds,
  status, correctness, exit, host, runtime, fixtures,
  scope: 'startup-through-publication-and-descendant-exit',
  metrics: [{
    name: 'groupCommittedPeakBytes',
    value: null, unit: 'bytes', source: 'windows-job',
    kind: 'lifetime-high-water', coverage: 'incomplete',
    unavailableReason: 'collector-failed'
  }],
  phasesArtifact, timelineArtifact, artifactHashes
}
```

Write a launch record before starting the group and a completion record after
measurement; never overwrite either. The summary references both, preserving a
discoverable interrupted attempt even if the driver cannot publish completion.
Registry attempts remain the authority for worker ownership/recovery; the outer
records do not grant permission to reclaim a live worker.

Distinguish invalid output, application error, timeout, observed budget breach,
confirmed OOM, unknown crash, collector failure and unavailable dependencies.
Use Linux cgroup OOM counters or Windows job/runtime evidence to establish OOM;
a generic nonzero exit or signal alone is not sufficient. With a crashed collector,
the last sampled maximum is a lower bound with incomplete coverage. A failed
workload's measured peak does not demonstrate capacity to finish that workload.
Preserve all failed/abandoned attempts; retries get new identities.

## Aggregation and regression policy

Publish one row per case with all attempt statuses, successful sample count,
platform-qualified peak metric, median, minimum, maximum and MAD, wall time,
throughput, output size and correctness. Show the largest observed successful
peak for planning with explicitly chosen headroom; it is no guarantee about future
runs. Seven repetitions do not support a reliable tail-percentile capacity claim.
Do not combine heterogeneous workload memory into one score.

For scaling, plot peak against each workload axis and report adjacent finite
differences in bytes/event or bytes/worker. Compare plateau versus growing demand,
without claiming an asymptotic law from three points. Paired comparisons retain
absolute byte changes and relative changes for the same metric/method; Linux
charged-memory peaks and Windows committed-memory peaks are never pooled.

Initially collect baselines without pass/fail memory gates. After pilot variance
is known, freeze a case-specific absolute-plus-relative tolerance and memory budget
in the plan. A provisional rule might flag a paired median increase exceeding both
32 MiB and 10%; these numbers require calibration and are not statistical proof.
For an improvement claim, predeclare an effect-size interval method and adequate
independent pairs; report uncertainty or inconclusive evidence. Repeated samples
within one process are not independent repetitions. This follows the experimental
principles in [Kalibera and Jones](https://kar.kent.ac.uk/33611/45/p63-kaliber.pdf);
their timing analysis motivates the design, not a ready-made memory estimator.

Budget runs are separate from unconstrained characterization. Pin cgroup
`memory.max` and swap policy or Windows job commit limits, together with V8/model
settings; these limits have different semantics. Report completed-work rate and
confirmed failures at every tested budget. The smallest tested successful budget
is an observed result, not an inferred universal minimum.

## Implementation sequence and acceptance

1. Implement the deep module, one serial disk-replay case, immutable outer records,
   natural GC, Linux/Windows group containment and lifetime counters. Reuse the
   existing scaling worker logic. Verify completion through result publication.
2. Add repetitions, bounded external timelines, phase snapshots, overhead pilot,
   controlled storage/order/report cases and baseline comparison. Consolidate the
   two old benchmark scripts and update existing test invocations in this change.
3. Add 1/2/5-worker campaigns, budget/failure cases and checkpoint/retention suites.
4. Add representative validation/archive/model suites without changing accounting,
   execution, split, holdout or metric implementations.

Acceptance checks cross `runMemoryBenchmark`'s interface in the existing replay
end-to-end tests: real fresh PIDs/groups, immutable fixtures/artifacts, exact
outcomes, complete attempt population, unsupported collectors and crash/timeout
cleanup. Exercise OS collectors with touched-page allocation fixtures, including
a short allocate/free burst during synchronous work, a native descendant and two
workers whose bursts do not overlap. Assert that lifetime counters catch bursts
and include descendants, while a sampled timeline may miss them; never require
exact allocator-dependent byte readings or a specific RSS decrease after freeing.
Use platform-qualified expectations and mark missing facilities explicitly.

Run `npm test` and `npm run test:regression` for the implementation's shared
research/infrastructure changes. Full demanding suites are explicit benchmark jobs
on controlled hosts, not timing assertions in CI. CI smoke validates the harness
and existing proof/execution contracts; release comparisons retain raw records.
Memory measurement, OS containment, vendor data, foreign model code and performance
claims remain outside the Bend/Lean proof scope.
