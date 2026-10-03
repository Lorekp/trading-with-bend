# Research: measuring execution speed credibly

Researched 2026-10-03. This note records methodology before benchmark design or
implementation. Recommendations below are proposed project choices; cited tools
and studies provide evidence, not a universal benchmark configuration.

## Define the claim and representative work

V8 retired Octane as a general performance proxy after optimizations improved its
scores while harming real workloads. Different workloads stressed execution,
parsing, compilation, and memory differently. A fast synthetic loop therefore
does not establish that an application is faster. [V8: Retiring Octane](https://v8.dev/blog/retiring-octane)

**Recommendation:** make complete research/replay operations the primary work.
Freeze a small, declared workload matrix covering typical size, long history,
different fill/order densities, and relevant audit/trace modes. Use downloaded
data snapshots for representative cases and deterministic generated cases for
controlled scaling. Record the same input hash, configuration, and seed for both
versions. Diagnostic microbenchmarks can explain a bottleneck after it is observed.
Report every declared case separately; a suite score must disclose its weights.

## Specify the timed operation

Google Benchmark distinguishes user-visible wall time from total process CPU
consumption; it also allows explicit exclusion of setup. It warns that repeatedly
pausing timers adds overhead. [Google Benchmark: CPU timers and timer control](https://github.com/google/benchmark/blob/main/docs/user_guide.md#cpu-timers)

**Recommendation:** use three separately named scopes when relevant:

| Scope | Included work | Interpretation |
| --- | --- | --- |
| Process operation | Launch, imports, input loading, computation, required output | Time to finish a real command |
| Loaded replay | Replay from prepared input through its complete returned result | Compute speed with loading excluded |
| Campaign | Queueing, configured workers, artifacts, complete declared trials | Actual study completion throughput |

Build and download before a campaign. Do not sum these scope timings or compare
results across scopes. Record output work and concurrency explicitly. Await
completion of all relevant work before stopping a timer. Initialization necessary
for each operation stays inside that scope; never time just an internal loop while
claiming complete-operation speed.

## Handle JIT warmup as an observed property

V8 uses multiple execution tiers and can deoptimize and recompile when feedback
changes. [V8: Maglev](https://v8.dev/blog/maglev)

Barrett et al. found that widely studied deterministic microbenchmarks could
slow down, fail to reach steady state, or behave differently across fresh process
executions. A fixed discarded prefix did not guarantee steady-state performance;
simple low-variance-window heuristics could misclassify runs. Their historical
VM results are evidence of methodological risk, not estimates for current Node.
[Barrett et al.: Virtual Machine Warmup Blows Hot and Cold, sections 1, 5 and 7](https://soft-dev.org/pubs/html/barrett_bolz-tereick_killick_mount_tratt__virtual_machine_warmup_blows_hot_and_cold_v6/)

**Recommendation:** retain ordered warmup and measured samples. A fresh-process
operation measures its natural JIT/GC behavior with no discarded work. A warmed
replay uses a documented prefix chosen from separate pilot runs, followed by a
fixed measurement budget. Name it “after configured warmup” unless observed time
series support a steady-state claim. Inspect multiple process traces for drift
and changing modes. If stability is absent, report that fact and the fixed-budget
result. Do not disable normal JIT or GC to manufacture a favorable number, or
select each run's fastest segment.

## Repeat processes and randomize comparisons

pyperf separates fresh processes, values per process, warmups, and inner loops.
Its workers run sequentially, with calibration outside the measured population.
Its default minimum raw duration is 100 ms; JIT defaults differ from non-JIT
defaults. These are tool choices, not prescriptions for Node.
[pyperf: architecture and repetitions](https://pyperf.readthedocs.io/en/stable/run_benchmark.html#pyperf-architecture),
[pyperf: runner configuration](https://pyperf.readthedocs.io/en/stable/runner.html#loop-iterations)

Google Benchmark provides randomized interleaving to reduce run-to-run variance.
[Google Benchmark: random interleaving](https://github.com/google/benchmark/blob/main/docs/random_interleaving.md)

**Recommendation:** compare serial fresh-process pairs on the same machine.
Randomly shuffle a balanced set of AB and BA orders using a recorded scheduling
seed. Pair by workload, input and trial seed. Neither version shares a process
with the other. Pilot batching until timer overhead is negligible; reset mutable
state for every operation. Use a fixed declared number of process pairs chosen
from pilot variability and available runtime, rather than stopping when a result
becomes favorable. Quick smoke runs may verify operation, but cannot justify a
performance claim. Campaign concurrency belongs in its own workload.

## Estimate uncertainty at the right level

Kalibera and Jones model distinct sources of nondeterminism and emphasize
confidence intervals for effect sizes, including execution-time ratios. Their
bootstrap preserves experimental hierarchy; flattening measurements loses that
structure. Pilot variability can guide allocation of repetitions.
[Kalibera and Jones: Quantifying Performance Changes with Effect Size Confidence Intervals, sections 4, 6 and 7](https://arxiv.org/html/2007.10899)

**Recommendation:** reduce equal-budget measured samples to one arithmetic mean
per process. For a workload, report baseline and candidate means and
`time ratio = mean(candidate process means) / mean(baseline process means)`;
values below one favor the candidate. Bootstrap complete process pairs with
replacement, retaining pairing, and recompute that ratio for a 95% interval.
This paired procedure is our adaptation of the hierarchical principle. The
sample size is the number of process pairs, not bars, fills, inner iterations,
or bootstrap draws. Preserve within-process samples for diagnostics, without
pretending they are independent replications. Intervals assume representative,
sufficiently independent pairs; persistent time drift demands investigation.
Declare practical thresholds beforehand. Distinguish inconclusive results from
evidence of negligible change. Several workloads require care with simultaneous
regression claims; do not pick a winner from many individual intervals.

## Measure time and memory without distorting work

Node documents high-resolution `performance.now()` timestamps in milliseconds.
`process.cpuUsage(previous)` supplies process user/system CPU deltas in
microseconds; CPU time may exceed elapsed time with parallel work.
`process.resourceUsage().maxRSS` is lifetime peak resident memory in KiB.
`process.memoryUsage()` supplies snapshots in bytes and may be expensive;
`memoryUsage.rss()` is faster. Event-loop utilization is not CPU utilization.
[Node: performance measurement](https://nodejs.org/api/perf_hooks.html#performancenow),
[Node: process measurement](https://nodejs.org/api/process.html#processcpuusagepreviousvalue)

**Recommendation:** report wall duration as primary, CPU delta as explanatory.
Time the whole operation with a monotonic high-resolution clock; avoid per-bar
instrumentation. Collect memory snapshots outside timing. Report peak RSS as
whole-worker lifetime, including loading/warmup/validation; do not label its
difference as operation allocation. End heap/RSS snapshots are not peaks or total
allocated bytes. Use separate diagnostic runs for allocation profiling or intrusive
GC observation. Child-process CPU usage needs child instrumentation, not the
parent's CPU counter. Keep ordinary GC costs in timings.

## Correctness, disclosure, and complete reporting

SPEC's rules require validated output, reproducible conditions, and disclosure
of performance-relevant configuration. These are useful principles here; this
project would not be producing a SPEC result.
[SPEC CPU2017: run and reporting rules, sections 1.2, 1.3 and 4](https://www.spec.org/cpu2017/Docs/runrules.html)

**Recommendation:** validate comparable accounting, fills and required outputs
before accepting speed comparisons. Consume returned results; compute complete
equivalence checks outside loaded-replay timing, while keeping normal result
construction inside. A variant omitting required audit work belongs in a separate
case. Retain failures, timeouts, correctness mismatches, slow samples, and original
ordering. Incomplete pairs cannot enter a paired estimate; disclose missingness
and withhold a claim when it could bias the comparison. Never silently trim runs.

Save raw measurements and resolved protocol with commit plus dirty/source hashes,
input/output hashes, dependency versions, Node/V8 versions and flags, OS, CPU,
RAM, worker count, seeds, timestamps, timer units, and scope. Record cache,
affinity and power settings when relevant; avoid saving unrestricted environment
variables. Keep workloads and protocol fixed before measuring candidates.

pyperf identifies CPU topology, frequency scaling, thermals and power supply as
sources of variation. [pyperf: system tuning](https://pyperf.readthedocs.io/en/stable/system.html)
Run on a quiet machine, on mains power, with a documented consistent power mode.
Disclose tuning rather than silently changing host settings. Timing gates belong
on stable dedicated runners after their noise floor is established; ordinary CI
can validate benchmark execution and correctness without brittle speed thresholds.
