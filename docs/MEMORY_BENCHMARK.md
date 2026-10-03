# Running the memory benchmark

The benchmark is implemented by `runMemoryBenchmark(plan, { outputDirectory })`
in `experiments/memory/benchmark.mjs`. `npm run benchmark:memory` is its command-line
interface. Build once before starting a study; do not edit toolkit or benchmark
sources while it runs. Every run needs a new output directory.

```powershell
npm run build
npm run benchmark:memory -- --suite smoke-v1 --output output/memory/smoke
npm run benchmark:memory -- --suite replay-v1 --ticks 2000000 --repetitions 7 --output output/memory/replay-2m
npm run benchmark:memory -- --suite campaign-v1 --ticks 2000000 --jobs 5 --workers 5 --repetitions 7 --output output/memory/campaign-2m
```

| Suite | Work |
| --- | --- |
| `smoke-v1` | 1,307 quotes, one replay and a two-job campaign, two repetitions. |
| `replay-v1` | One replay; `--ticks` defaults to 250,000. |
| `campaign-v1` | `--jobs` replays at `--workers` concurrency, sharing one fixture. Defaults to five jobs/workers and 250,000 quotes each. Keep job count fixed across concurrency comparisons. |
| `replay-demanding-v1` | Frozen 250,000/1,000,000/2,000,000 replay ladder and five-job 2,000,000-quote campaigns at concurrency 1/2/5. Prepares three fixtures. This is a long study. |
| `controls-v1` | Disk baseline, in-memory data, memory audit with full report, unbounded callback history, full disk report, dense orders, and smaller compact/full all-order reference traces. Compare memory audit to the full disk report to hold reporting detail constant. |
| `churn-v1` | 1/64/512 simultaneously working orders, partial fills and cancellations. `--ticks` here counts submit/fill/cancel cycles (default 1,024), not observations. |
| `restore-v1` | Fresh-process restoration at 25/50/100% of a quote-only prefix, then deterministic continuation. Checkpoint preparation is separately measured. |
| `retention-v1` | Twenty sequential replay/report/cleanup cycles in one worker, default 25,000 quotes/cycle. Retains post-cleanup snapshots and small cycle results, with natural GC. Growth is diagnostic, not proof of a leak. |
| `overhead-v1` | Identical replay at high-water-only and 10/50/200 ms resident sampling, in saved randomized order. |
| `collector-calibration-v1` | Idle and touched-buffer allocation; on Windows also native allocation, sequential/overlapping bursts and a detached descendant that survives its supervisor. These validate measurement, not trading capacity. |

Except smoke, suites default to seven repetitions. `--repetitions`, `--order-seed`,
`--timeout-ms`, `--sample-ms`, `--order-every` and `--node-options` are explicit
configuration. Natural GC is mandatory; only old/semi-space size flags are admitted.
The default `--node-options` is `--max-old-space-size=2048`, and queued workers
inherit that exact value. `--sample-ms 0` disables the resident timeline while
preserving OS high-water collection. A heap limit does not limit whole-group memory.

Use `--dataset path/to/manifest.json` with an exact matching `--ticks` count to
reuse admitted quotes. The frozen demanding suite prepares its own size ladder;
it does not accept one shared manifest for different sizes. Input preparation
otherwise runs once per distinct count in its own measured group. Those records
remain separate from replay/campaign repetitions.

For a saved plan, use `--plan plan.json` and optional `--output`. Example:

```json
{
  "version": 1,
  "suite": "campaign-v1",
  "ticks": 250000,
  "jobs": 5,
  "workers": 2,
  "repetitions": 7,
  "orderSeed": 41,
  "sampleMs": 50,
  "timeoutMs": 3600000,
  "runtime": { "nodeOptions": "--max-old-space-size=2048" }
}
```

## Collectors and scope

Windows x64 compiles a small C# collector using the installed .NET Framework
compiler into a source-hashed path under `.tools/memory/`. It starts Node suspended,
assigns it to a Job Object, resumes it and waits for all associated processes to
exit. The collector remains outside the job. `groupCommittedPeakBytes` is the
Job's committed-memory high water, including ordinary descendants and console
hosts; it is not RSS. Nested-job assignment failures are explicit collector failures.

Linux requires a delegated cgroup v2 parent with the memory controller, `memory.peak`
and `cgroup.kill`. The default parent comes from `/proc/self/cgroup`; set
`--cgroup-parent /path/to/delegated/cgroup` when required. The launcher joins before
executing Node. `groupChargedPeakBytes` includes cgroup-charged cache/kernel memory
as well as anonymous allocations. Swap is explicitly disabled for the measured
group. The benchmark does not enable controllers or change machine-wide settings.
Missing collector access fails explicitly; it never silently substitutes snapshots.

`--budget-bytes N` sets a job commit limit on Windows or `memory.max` on Linux.
These limits have different semantics. A generic application crash under a budget
is not classified as OOM without specific evidence; Linux `oom_kill` counters
provide that evidence. Use budget studies separately from unconstrained results.

Measured scope includes startup/imports, supervisor enqueueing, worker admission,
replay, report sealing, artifact serialization, registry inventory/publication,
supervisor verification and the final descendant exit. Independent saved-fill
verification and outer summary/hash publication happen after measurement.
Phase records use each emitter's monotonic clock, explicitly without cross-process
alignment; they do not claim exact group phase peaks.

Sampled RSS/working set is a finite-polling aggregate. Sequential reads introduce
skew, spikes/short-lived processes can be missed and shared pages can be counted
more than once. Timelines record actual gaps, sample duration, failed process reads
and observed overlap. Compare OS high waters separately from this diagnostic view.
Heap/external/ArrayBuffer snapshots are overlapping measures and must not be added.

## Evidence and interpretation

`summary.json` contains every measurement and preparation attempt, case-level
median/minimum/maximum/MAD, elapsed time, observation throughput, fill counts and
audit bytes. Each attempt directory has its specification, launch/completion
records, collector result, timeline, per-process phase logs, supervisor logs and
registry. Registry results bind complete immutable audit artifacts. Outer completion
records bind streamed artifact hashes, including evidence that outlives workers.
Keep all these files together for verification or checkpoint restoration.

Failures retain available peaks, logs and incomplete artifacts. Failed peaks are
excluded from successful-case statistics, but the statuses and raw attempts remain.
Successful replays must pass independent exact roundtrip counts/ledger checks,
streamed saved-fill posting reconciliation and repeated trace/signal identity checks.
Memory audits use full reporting so complete evidence survives worker exit.

Local host load and actual filesystem cache residency are uncontrolled and labelled
in the metadata. Sampling overhead must be investigated with `overhead-v1` before
performance claims. There are no automatic memory-regression gates, improvement
claims or reliable tail-percentile estimates. Linux/Windows primary peaks are
different metrics and must not be pooled.

The [research](MEMORY_BENCHMARK_RESEARCH.md) explains the source facts and the
[design](MEMORY_BENCHMARK_DESIGN.md) records the broader workload catalog.
See the [results](MEMORY_BENCHMARK_RESULTS.md) for executed capacity and sampling studies.
Validation/model/archive suites, forced-GC retention diagnostics and statistical
A/B comparison gates remain extensions to this implemented execution benchmark.
OS measurement and foreign code are outside the Bend/Lean proof scope.
