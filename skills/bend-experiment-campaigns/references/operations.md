# Campaign capacity, failure and recovery

## Freeze the runtime used by a campaign

Build once before enqueueing. Build locks prevent simultaneous writers; stale-lock recovery requires checking that the recorded process exited. Shared source edits change pinned toolkit identity and make existing queued jobs reject drift before or after work. Develop new shared infrastructure in another checkout/version rather than editing underneath a running campaign.

Multiple runners can compete for a registry job on a supported local filesystem; atomic claims decide ownership. Each runner's `concurrency` is its own limit. Four agents each launching four workers create up to sixteen workers, not a shared four-worker budget. Coordinate CPU, Python threads, memory, disk and queue timeouts according to the actual workload.

Admit reusable quote/information datasets once, reopen read-only cursors per worker, and own a new audit directory per replay. Use bounded history, active order storage and compact traces; keep all orders/fills on disk. Full reports, sequence packing and derivative arrays still have explicit memory costs. Event count and payload size determine capacity, not the number of calendar years.

For a slowdown, profile a representative bounded reproduction first. `npm run benchmark` and `scripts/profile-replay.mjs` serve different purposes: fresh-process paired comparisons versus diagnostic profiling. Preserve exact economics/audit identities while optimizing. Faster results from coarser data, shorter windows or fewer trials are a changed workload/experiment, not automatically a faster equivalent implementation.

## Failed work stays visible

Crashes/timeouts/invalid artifacts remain registered. Completed or failed jobs are not automatically rerun. Report abandoned and unresolved work; do not filter the population down to successes. Job/artifact verification errors are evidence to diagnose, not permission to edit old manifests.

Use `recoverExperiment(root, key)` or the existing CLI only after both recorded owner and supervisor are dead on the original host. PID reuse can conservatively block recovery. Never delete a live claim to steal a job. Recovery preserves abandoned attempts and advances a claim generation. A dead inline callback cannot be queued because its closure is gone; register a fresh inline trial to repeat it.

A final-holdout claim is a different object from a recoverable worker claim. The final release remains consumed after failure/crash; worker recovery cannot reset it. Keep partial final evidence and report the limitation.

## Basis

Local: `AGENTS.md`, `docs/RESEARCH.md`, `docs/ADAPTERS.md`, `docs/BENCHMARK.md`, `src/experiments.mjs`.

Distilled from [Algorithm Performance](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/algorithm-performance) and [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide). Registry ownership/recovery rules are local requirements, not vendor guidance.
