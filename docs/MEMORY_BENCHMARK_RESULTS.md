# Memory benchmark results

Run on 2026-10-03. These are local measurements of the implemented execution
benchmark, with seven fresh-process repetitions per capacity case. Read the
[running guide](MEMORY_BENCHMARK.md) for measurement scope and available suites,
and the [research](MEMORY_BENCHMARK_RESEARCH.md) for the measurement principles.

## Environment and method

Windows x64, OS release `10.0.26200`, AMD Ryzen 5 7600X (12 logical CPUs),
33,378,181,120 bytes of installed RAM, Node `v24.12.0`, V8
`13.6.233.17-node.37`. Every Node worker used
`NODE_OPTIONS=--max-old-space-size=2048`, with natural GC. Host activity and
filesystem cache residency were uncontrolled. Inputs were validated before replay.

The primary metric is Windows Job Object `PeakJobMemoryUsed`, recorded as
`groupCommittedPeakBytes`. It covers the supervisor, workers and associated
descendants from startup through durable publication and final descendant exit.
The observer runs outside that job. This is a simultaneous whole-job committed
memory high water, not RSS, retained heap, or a sum of process peaks.

Each replay used disk-backed admitted quotes and complete disk audits, compact
traces, active-order storage, a 256-observation callback history, summary reporting
and one alternating order every 288 observations. The deterministic two-million
quote fixture has dataset hash
`59f41b34c7d9cf083d41104be3a3a00561287532971880e6341d5f404c00b4fb`.
The campaign reuses this exact fixture. Preparation is separately measured.

Every successful attempt must satisfy independent order/fill/ledger counts,
saved-fill posting reconciliation, artifact verification and repeat trace/signal
identity. Failed attempts remain in the population and are excluded from
successful-case statistics. The saved randomized repetition order uses seed 41.

## Capacity results

The two-million-quote serial case completed all seven repetitions. Its median
whole-job committed peak was **648.82 MiB**, ranging from **638.80 to 660.93 MiB**,
with a median absolute deviation of **6.13 MiB**. Median elapsed time was
**129.707 seconds** (range 125.386–133.688), or **15,419 observations/second**.
Every repetition produced 6,945 fills and a 374,181,888-byte audit database.

The five-worker campaign also completed all seven repetitions. Each processed
10,000,000 observations and produced 34,725 fills. Its median whole-job committed
peak was **2,827.73 MiB (2.76 GiB)**, ranging from **2,752.32 to 3,501.07 MiB
(2.69–3.42 GiB)**, with a median absolute deviation of **75.41 MiB**. Median elapsed
time was **181.860 seconds** (range 159.510–199.425), or **54,987 aggregate
observations/second**. Each campaign produced 1,870,876,672 bytes of audit databases.
The 3.42 GiB observation remains in the statistics; it was a correct completed
attempt. The observed range does not establish a minimum safe memory budget.

| Work per repetition | Repetitions completed | Median committed peak MiB | Peak range MiB | Median elapsed seconds |
| --- | ---: | ---: | ---: | ---: |
| One 2,000,000-quote replay | 7/7 | 648.82 | 638.80–660.93 | 129.707 |
| Five concurrent 2,000,000-quote replays | 7/7 | 2,827.73 | 2,752.32–3,501.07 | 181.860 |

Together the capacity studies completed **42 replays and 84,000,000 observations**.
There were no failed capacity attempts. Every recorded OS high water has complete
job-lifetime coverage, and the final benchmark source hashes match both saved
study plans. Different work totals mean these rows are not a fixed-work comparison
of concurrency levels.

The serial study also retains its separately measured input-preparation attempt.
Input construction is excluded from replay/campaign capacity comparisons.
Independent saved-fill validation and outer artifact hashing occur after the
measured job exits; report sealing and registry publication occur inside it.

## Sampling calibration

The same 250,000-quote workload ran seven times at each polling interval, in saved
randomized order. All 28 attempts completed and passed correctness checks.

| Resident polling | Median elapsed seconds | Observed elapsed range | Median committed peak MiB |
| --- | ---: | ---: | ---: |
| Disabled | 14.385 | 13.353–15.044 | 363.74 |
| 10 ms | 14.702 | 14.260–15.493 | 366.61 |
| 50 ms | 15.159 | 14.033–16.900 | 361.13 |
| 200 ms | 14.234 | 13.442–15.120 | 363.26 |

The 50 ms median is 5.4% above the unsampled median. Overlapping ranges and local
host variation prevent a causal overhead estimate from these summaries. The pilot
does not establish the design's provisional 2% overhead target, so both capacity
studies use `--sample-ms 0`. This preserves the Job Object high water and sparse
phase snapshots while disabling resident-memory polling. No sampled resident peak
is claimed for these capacity runs.

## Reproduction and artifacts

Build once, then use new output directories. The capacity commands below use the
current `scripts/benchmark-memory.mjs` name (originally `scripts/benchmark.mjs`):

```powershell
node scripts/benchmark-memory.mjs --suite replay-v1 --ticks 2000000 --repetitions 7 --sample-ms 0 --output output/memory/replay-2m-seven

$fixture = (Get-Content output/memory/replay-2m-seven/fixtures.json -Raw | ConvertFrom-Json)[0].manifestPath
node scripts/benchmark-memory.mjs --suite campaign-v1 --ticks 2000000 --jobs 5 --workers 5 --dataset $fixture --repetitions 7 --sample-ms 0 --output output/memory/campaign-2m-five-seven
```

The overhead study used `overhead-v1`, `--ticks 250000`, `--repetitions 7` and
the admitted fixture from `output/memory/replay-pilot-250k`.

Raw records are local, ignored artifacts under `output/memory/`. Keep complete
study directories and the fixture preparation together: summaries refer to
immutable registry results and full audit files. Each study retains its plan,
host/runtime/source hashes, fixture hashes, order, collector configuration,
attempt statuses, logs and per-process phase snapshots.

- [Serial summary](../output/memory/replay-2m-seven/summary.json)
- [Campaign summary](../output/memory/campaign-2m-five-seven/summary.json)
- [Sampling study](../output/memory/overhead-250k-seven/summary.json)

## Verification and limits

The full test suite passed 135 tests, with three skips and no failures. The
regression suite passed 115 tests, with one skip and no failures. Build verification
passed the pinned Bend compiler and Lean kernel checks. Collector regressions
cover synchronous allocations, native allocations, sequential and overlapping
children, descendants surviving their root, explicit timeout termination and
retention of failed attempts. Small end-to-end runs also exercised controls,
working-order churn, checkpoint restoration and repeated cleanup.

The full-suite skips were the two downloaded-ETH integration cases and the optional
real PyTorch/LightGBM adapter integration, which were not enabled in this environment.

The actual Linux preflight failed explicitly with `COLLECTOR_UNAVAILABLE` because
this WSL environment lacks delegated cgroup access. Its positive collection path
has not been validated here. Linux charged-memory peaks and Windows committed
peaks have different semantics and must not be pooled.

These runs cover a large serial replay and five concurrent large replays. They do
not execute the entire `replay-demanding-v1` concurrency/size matrix, establish a
minimum memory budget, estimate reliable tail percentiles, prove a leak, or measure
forecasting/model workloads. OS collection and foreign runtime behavior remain
outside the Bend/Lean proof boundary.
