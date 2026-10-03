# Memory benchmark research

Research date: 2026-10-03. Scope: demanding Node.js work, native subprocesses,
and multiprocess research campaigns on Linux and Windows. Node documentation
below is pinned to v22.16.0, the repository's minimum supported Node 22 release.
This note establishes measurement principles; it contains no benchmark results.

## What the primary sources establish

### Node memory is more than the V8 heap

`process.memoryUsage()` reports bytes: `heapUsed`/`heapTotal` describe V8;
`external` tracks C++ allocations associated with managed JavaScript objects;
`arrayBuffers` includes Node Buffers and is already included in `external`.
RSS covers resident code and native/JavaScript allocations. With Worker threads,
RSS describes the process, while the other fields describe the calling thread.
The full call can be slow; `memoryUsage.rss()` is faster. Allocator fragmentation
can increase RSS while V8 heap size stays stable. `resourceUsage().maxRSS` reports
the current process's high water in kilobytes. These fields are overlapping
views, not terms to add into a memory total.
[Node process documentation](https://nodejs.org/download/release/v22.16.0/docs/api/process.html#processmemoryusage),
[Node resource usage](https://nodejs.org/download/release/v22.16.0/docs/api/process.html#processresourceusage).

On Windows, libuv obtains this high water from `PeakWorkingSetSize` and divides
by 1024. Record Node/libuv versions and normalize `maxRSS * 1024` to bytes.
[libuv Windows implementation](https://github.com/libuv/libuv/blob/v1.51.0/src/win/util.c).

### Samples and high waters answer different questions

Node timers become eligible after a threshold; callbacks and scheduling can
delay execution. Therefore a timer in the workload cannot observe an allocation
burst and release that both happen inside synchronous work. That conclusion is
an inference from Node's documented execution model.
[Node event loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick).

Linux `getrusage(RUSAGE_SELF)` includes all process threads. Its `ru_maxrss` is
KiB. Crucially, `RUSAGE_CHILDREN.ru_maxrss` is the largest child's high water,
not the process tree's simultaneous peak.
[Linux getrusage](https://man7.org/linux/man-pages/man2/getrusage.2.html).

For observed process values `M_i(t)`, the simultaneous aggregate is
`max_t(sum_i M_i(t))`. The sum of individual high waters is an upper bound on
this aggregate when membership and memory definitions agree; it is not its
measurement. Finite polling can miss short bursts and short-lived children;
sequential reads across processes are also not an atomic snapshot. These are
measurement deductions, rather than guarantees supplied by an operating system.

### Linux process and containment accounting

Linux `/proc` exposes `VmHWM` and `VmRSS`. Kernel documentation cautions that
scalable RSS accounting can be imprecise; `smaps` scans page tables more
precisely at greater cost. PSS apportions shared pages among the processes
mapping them, reducing the double counting inherent in summing RSS.
[Linux proc documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

The cgroup v2 `memory.current` counter covers a cgroup and its descendants;
`memory.peak` records their maximum since creation or reset. This accounting
includes anonymous memory, page cache, and certain kernel allocations/socket
buffers. It is broader than process RSS. `memory.events` exposes OOM events,
and `memory.swap.current` tracks swap separately. Peak availability and reset
semantics depend on the installed kernel; current documentation specifies that
a reset is associated with the same open file descriptor.
[Linux cgroup v2 memory](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#memory).

### Windows residency and committed memory

`PROCESS_MEMORY_COUNTERS_EX` distinguishes current/peak working set from
`PrivateUsage`/`PagefileUsage`, which represent private committed memory, and
`PeakPagefileUsage`, its lifetime peak. Committed memory need not all be
resident. Consequently, private commit must not be renamed RSS.
[Microsoft process counters](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex).

Windows Job Objects provide process grouping. Their extended information
describes committed-memory limits and constantly tracked `PeakJobMemoryUsed`
across associated processes. This supports a Job committed-memory high water,
not a resident working-set high water.
[Microsoft Job extended information](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information).

Ordinary children inherit Job association, with documented breakaway and nested
Job exceptions. `CREATE_SUSPENDED` stops the primary thread until `ResumeThread`;
assignment before resume avoids user workload running before containment.
Failure to assign must be surfaced, including restrictions imposed by an
existing Job. An implementation should not silently continue without coverage.
[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags),
[Job assignment](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

Job completion-port notifications are generally not guaranteed, and the Job
handle's documented signaled condition is end-of-job time-limit termination.
Determine ordinary completion through checked active-process accounting rather
than assuming root exit or a signaled Job handle establishes an empty tree.
[Microsoft Job lifecycle](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects#resource-accounting-for-jobs).

### GC and diagnostic tools change the experiment

`--max-old-space-size` limits V8's old generation, not total process/tree memory;
approaching the limit increases GC effort. `--expose-gc` exposes a V8 extension.
Heap configuration therefore belongs in the experiment identity.
[Node command-line documentation](https://nodejs.org/download/release/v22.16.0/docs/api/cli.html#--max-old-space-sizesize-in-mib).

Heap snapshots stop the main thread and can double the heap, potentially
crashing the process. They are unsuitable as primary benchmark instrumentation.
[Node heap snapshot guidance](https://nodejs.org/learn/diagnostics/memory/using-heap-snapshot).

### Repeatability requires explicit conditions and valid work

SPEC CPU's rules require output validation, disclosure of relevant conditions,
and repeated runs. Its three-run median is a precedent for repeatability, not a
universal sample-size rule for a memory benchmark.
[SPEC CPU2017 run rules](https://www.spec.org/cpu2017/Docs/runrules.html#rule_1.2).

Kalibera and Jones model multiple sources of execution-time variation and
confidence intervals for effect sizes. Their framework supports pilot-driven
repetition at the level where variability occurs. Applying its principles to
memory requires checking the memory observations' distribution and estimand.
[Authors' research publication](https://www.cs.kent.ac.uk/pubs/2012/3233/).

Mytkowicz et al. demonstrate that innocuous experimental setup choices can bias
systems measurements; they propose causal checks and setup randomization.
Repeated runs alone cannot establish absence of systematic bias.
[Authors' paper summary](https://sape.inf.usi.ch/publications/asplos09.html).

## Design recommendations for this repository

The following are proposed decisions inferred from the evidence and repository
workloads. They are not requirements stated by the sources.

1. **State the estimand and scope.** Primary capacity results are absolute
   lifetime memory highs for the whole workload, including runtime startup,
   dataset acquisition/loading, replay, audit persistence, report serialization,
   and descendants. Exclude the independent benchmark observer. Keep warmed
   execution and post-cleanup retained-memory diagnostics separate. Never
   subtract two lifetime highs to infer a phase's peak.
2. **Keep platform metric names.** Linux capacity mode uses a fresh cgroup's
   charged-memory peak, with sampled RSS/PSS only as explanatory views. Windows
   uses a fresh Job's committed-memory peak plus sampled aggregate working set.
   Report adapter, scope, units, counter kind, coverage limitations, and actual
   OS/kernel versions. Compare implementations within one metric/platform;
   do not average these unlike metrics into a cross-platform score.
3. **Contain before execution and observe through completion.** Place the root
   in containment before it executes workload code; ordinary descendants remain
   included. Retain the containment handle until all assigned processes finish
   and final counters are collected. A child that outlives its root remains part
   of the trial. Missing permissions/counters produce an explicit unsupported
   or incomplete result; sampled fallback results carry a different label.
4. **Combine highs with independent sampling.** Use OS high waters for short
   bursts and an external observer for timelines during synchronous work. Add
   sparse phase checkpoints for heap/external/Buffer attribution. Start with a
   declared polling interval, then calibrate both shorter and longer intervals
   on representative work; record actual gaps, sample count, and missed reads.
   Polling peak is an observed peak with finite resolution, not an exact peak.
5. **Use natural GC for primary capacity.** Remove optional `global.gc()` from
   the primary protocol. A separate retained-memory diagnostic may release
   declared workload references, force GC, and record post-GC heap/residency.
   It cannot replace the natural-GC peak. Keep references alive until the
   measured outputs are consumed and validation finishes.
6. **Separate startup and warmed questions.** A fresh process per repetition
   avoids inherited heap/allocator/cache history. For a long-lived execution
   question, run a fixed documented warmup within each fresh process and retain
   the startup high separately; do not label its lifetime high a warmed peak.
   Pilot the steady behavior before choosing a warmup count. Do not silently
   clear the machine's page cache or discard expensive initialization.
7. **Repeat at process level.** Use a practical initial five independent trials
   per configuration, then increase repetitions based on pilot dispersion and
   desired sensitivity. Preserve every raw observation; summarize median,
   minimum/maximum, and failures. For A/B claims, interleave matched workload
   trials with a recorded random order seed; use process-level uncertainty
   intervals if enough repetitions justify them. Samples inside a single trial
   are correlated observations, not independent replicates. Five trials cannot
   justify a tail-percentile claim such as production p99.
8. **Pin the conditions.** Record code/toolkit/dependency/data hashes, dataset
   and trial seeds, row windows, concurrency, trace/history/audit policies,
   Node/V8/libuv/native/Python versions, runtime flags and relevant environment,
   CPU/RAM, swap/pagefile, containment limits, and observer configuration. Build
   before the campaign. Baselines must use the same work and configuration.

### Demanding workload construction

Use actual repository entry points and output validation. A small harness-only
allocation calibration proves measurement behavior; it does not establish the
toolkit's capacity. Choose deterministic workloads covering these distinct
memory drivers:

| Workload | Scaling dimensions | Required observation |
| --- | --- | --- |
| Archive through fills/report | bars, instruments, loaded files | decode/load overlap with execution and serialization |
| Replay with orders/audit | bars, fills, pending orders, audit policy | full records retained, compact/bounded callback policy recorded |
| Dense forecasting | rows, feature count, trials/folds | parent matrix/JSON plus Python/native allocations concurrently |
| Registry campaign | worker count, jobs, artifact size | supervisor plus workers/native descendants and final publication |
| Repeated long-lived execution | repeated equivalent tasks | natural-GC retained growth and allocator behavior over time |

Use a fixed small/medium/large geometric size ladder, independent concurrency
steps, and selected realistic combined extremes. Keep data distribution,
order density, audit semantics, model configuration, and random seeds stable
while changing one dimension. Report memory versus both input and output counts:
bytes per bar alone conceals fill/audit and feature-matrix growth. Include the
normal production policy as baseline; reduced history/tracing is a separately
named configuration with equal correctness obligations. Record capacity failures
at the failing size rather than trimming the matrix to successful workloads.

### Correctness, failure capture, and observer overhead

Validate fills/ledger/report counts or digests against existing reference paths
and pinned fixtures. Consume outputs so an implementation cannot win by omitting
work. Include output serialization and artifact publication when they belong to
the stated production scope; observer summary writing occurs after measurement.

Persist trial identity before launch. The observer writes partial samples,
exit/signal status, timeout, validation failure, and available high waters even
when the workload cannot emit a final result. Distinguish confirmed OOM from
unclassified termination: Linux containment OOM events provide evidence; a
nonzero exit or killed process alone does not. Budget/timeout terminations remain
in the attempted population and cannot appear as completed low-memory wins.

Use asynchronous spawning for observer control and stream/bound captured output.
Node's buffered child execution has `maxBuffer` limits that terminate children
when output exceeds the limit; synchronous execution can wait indefinitely if
the child handles termination without exiting. These can otherwise masquerade
as workload failures.
[Node child-process documentation](https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#child_processexecfilesyncfile-args-options).

Calibrate instrumentation with touched allocation bursts, overlapping and
nonoverlapping descendants, synchronous stalls, and a descendant that survives
the root. Compare representative runs with sparse versus normal observation to
quantify perturbation, rather than subtracting a guessed observer cost. Stream
samples to bounded storage; keep detailed profilers/heap snapshots in diagnostic
runs. A credible benchmark publishes metric semantics, raw trials, correctness,
failures, and observer coverage alongside its memory summary.
