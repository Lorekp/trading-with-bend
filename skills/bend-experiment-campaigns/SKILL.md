---
name: bend-experiment-campaigns
description: Run reproducible strategy or model campaigns in trading-with-bend with immutable registry identities, complete trial populations, verified dependencies and bounded parallel workers. Use for parameter grids, queued studies, artifact collection or failed/abandoned campaign recovery.
---

# Bend Experiment Campaigns

Keep every research attempt attributable, comparable and recoverable without taking a live worker's ownership.

Paths are relative to the target `trading-with-bend` repository. Read `AGENTS.md` and `docs/RESEARCH.md`, then inspect current campaign/registry exports and a nearby `evaluateStudy` worker. This skill adapts a 2026-10-03 documentation snapshot.

For a new campaign or changed inputs, read [registration-and-artifacts.md](references/registration-and-artifacts.md). Build once before admission. Official multi-agent studies use `createCampaign().submit/seal/run/report`, with one coordinator owning specification, total budget, common inputs and final authority. Use raw `enqueueExperiment` / `runQueue` or synchronous `runExperiment` for focused diagnostics. Give changed code/data/seeds/configuration a fresh versioned study identity.

For parallel capacity, worker failure or recovery, read [operations.md](references/operations.md). Coordinate shared admission as well as per-runner concurrency. Keep failed/abandoned attempts in the population and use verified official reports and registry reads when reporting.

Declare helpers as dependencies and external files through `inputFiles`; official submissions freeze toolkit, installed locked package bytes and those inputs. Give exploration workers train/validation-only values. Use `context.writeArtifact` for immutable plan, configuration, model and evidence artifacts. Preserve full replay audits and regular strategy/control returns when uncertainty analysis needs them.

Official completion means sealed membership, every admission registered and terminal, and a verified immutable campaign report. Pending/unregistered work remains visibly incomplete. Report the whole population and the predeclared economic accept/reject decision separately from the official raw-return winner. Final release uses `releaseCampaignFinal` and the coordinator's shared authority only when requested.
