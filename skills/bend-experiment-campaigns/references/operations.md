# Campaign capacity, failure and recovery

## Freeze the runtime used by a campaign

Build once before admission. Build locks prevent simultaneous writers; stale-lock recovery requires checking that the recorded process exited. Official campaigns execute frozen verified toolkit/package/worker/input copies, so original-source edits do not alter queued work. Lower-level unfrozen queues reject pinned drift before/after execution. Develop new infrastructure in another checkout/version and admit changed trials under new identities.

Multiple runners can compete on a local filesystem supporting atomic hard links; claims decide ownership. Each runner's `concurrency` is local. Set one absolute `admissionRoot` across registries/checkouts sharing a host and use identical immutable `resourceBudget` declarations. Campaign runners inherit the frozen budget; declare each job's `resources: { cpuThreads, memoryMiB }` within it. A bounded memory budget requires a positive job memory declaration. Reasoning agents share that replay budget; they do not each receive an independent allowance. These guarantees are local-host orchestration, not multi-host scheduling.

Profile a representative bounded slice before raising concurrency. Thread/memory declarations are admission estimates: BLAS/OpenMP settings and V8 old-space bounds are not total RSS/native/child-process OS quotas. Budget supervisor, coordinator, dataset preparation and disk headroom separately. Configure `timeoutMs`, `maxLogBytes`, `maxArtifactBytes` and `maxResultBytes`; output defaults are unbounded, violations fail the attempt, and direct writes may temporarily overshoot polling limits.

Use `queueStatus(registry, { admissionRoot })` for supervisors, durable reservations and admitted totals. Worker `context.reportProgress(json)` / `heartbeat()` expose latest timestamp/PID/RSS telemetry; progress fits 64 KiB. Telemetry is operational state, so preserve scientific evidence as immutable artifacts instead.

Admit reusable quote/information datasets once, reopen read-only cursors per worker, and own a new audit directory per replay. Use bounded history, active order storage and compact traces; keep all orders/fills on disk. Full reports, sequence packing and derivative arrays still have explicit memory costs. Event count and payload size determine capacity, not the number of calendar years.

For a slowdown, profile a representative bounded reproduction first. `npm run benchmark` and `scripts/profile-replay.mjs` serve different purposes: fresh-process paired comparisons versus diagnostic profiling. Preserve exact economics/audit identities while optimizing. Faster results from coarser data, shorter windows or fewer trials are a changed workload/experiment, not automatically a faster equivalent implementation.

## Failed work stays visible

Crashes/timeouts/invalid artifacts remain registered. Completed or failed jobs are not automatically rerun. Report abandoned and unresolved work; do not filter the population down to successes. Job/artifact verification errors are evidence to diagnose, not permission to edit old manifests.

After interruption, check both recorded owner and supervisor are dead on the original host. Run `recoverQueue(registry, { admissionRoot })` for shared reservations, then `recoverExperiment(registry, key)` for unfinished jobs. Reservation recovery does not rerun work; job recovery does not release external reservations. Preserve abandoned attempts and claim generations. Live owners and ambiguous PID reuse block recovery; never remove a live claim. A dead inline callback cannot be queued because its closure is gone; register a fresh inline trial to repeat it.

`cancelExperiment` retains cancellation in the population. Runner abort stops new admissions; `shutdown: 'drain'` finishes owned workers and `'cancel'` cancels them, leaving other runners' ownership intact. Fix intended recovery decisions before terminal completion freezes the official report. Later recovery cannot silently replace that report.

A final claim is separate from recoverable worker ownership. Official `releaseCampaignFinal` verifies the persistent winner/artifact inventory and derives a single-use claim from dataset/final-row identity at the shared authority. Failure/crash consumes it; worker recovery cannot reset it. Keep partial evidence and report the limitation. Reusing those observations under another name/authority is outside honest confirmation.

## Basis

Local: `AGENTS.md`, `docs/RESEARCH.md`, `docs/ADAPTERS.md`, `docs/BENCHMARK.md`, `src/campaigns.mjs`, `src/campaign-final.mjs`, `src/experiments.mjs`.

Distilled from [Algorithm Performance](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/algorithm-performance) and [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide). Registry ownership/recovery rules are local requirements, not vendor guidance.
