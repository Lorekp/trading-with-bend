---
name: bend-experiment-campaigns
description: Run reproducible strategy or model campaigns in trading-with-bend with immutable registry identities, complete trial populations, verified dependencies and bounded parallel workers. Use for parameter grids, queued studies, artifact collection or failed/abandoned campaign recovery.
---

# Bend Experiment Campaigns

Keep every research attempt attributable, comparable and recoverable without taking a live worker's ownership.

Paths are relative to the target `trading-with-bend` repository. Read `AGENTS.md` and `docs/RESEARCH.md`, then inspect current `src/experiments.mjs` / `src/search.mjs` interfaces and a nearby study worker. This skill adapts a 2026-10-03 documentation snapshot.

For a new campaign or changed inputs, read [registration-and-artifacts.md](references/registration-and-artifacts.md). Build once before enqueueing. Use `gridJobs`, `enqueueExperiment` and `runQueue` for asynchronous workers, or the registered synchronous `runExperiment` path for genuinely synchronous work. Give changed code/data/seeds/configuration a fresh versioned study identity.

For parallel capacity, worker failure, recovery or drift rejection, read [operations.md](references/operations.md). Coordinate the total process budget: queue concurrency is per runner. Keep failed/abandoned attempts in the population and use verified registry reads when reporting.

Pin helper modules, external models, both information/execution datasets, manifests and associated data files as dependencies. Use `context.writeArtifact` for immutable plan, configuration, model and evidence artifacts. Preserve the full audit through disk recording and summary reports for large runs.

Completion means registered outcomes and verified artifact references for the whole requested trial population, including pending/failed/abandoned statuses, plus the common comparison identities. A best-result JSON alone is not a completed campaign record.
