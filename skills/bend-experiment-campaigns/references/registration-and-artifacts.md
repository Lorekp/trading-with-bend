# Registration and repeatable evidence

## Local APIs

`gridJobs({ namespace, workerModule, baseConfiguration, space, dependencies, maxTrials, seed })` generates validation-only jobs. Enqueue each through `enqueueExperiment(root, job)` and execute `await runQueue(root, { concurrency, timeoutMs })`. Seeds are deterministic from keys unless declared; record dataset seeds separately from model/trial seeds.

The configuration must contain the inputs needed to reproduce a trial, including split/evaluation choices and model runtime where relevant. Shared toolkit and worker hashes are pinned by the registry. Arbitrary external transitive imports are not reliably inferred: explicitly declare helper modules, datasets, processed manifests plus shards/databases, requirements/lockfiles and model files used by the worker.

`gridJobs` hashes configuration and seed to form its key. Worker or dataset edits do not magically give that key a new meaning. Change the namespace/version when changing code or data, and keep old registries with the original checkout. A deliberate retry is an attempt in the same immutable specification only through supported recovery; a changed hypothesis/configuration is a new trial.

## Worker contract

Place the worker and helpers under `experiments/<study>/`. A worker exports `default async function(configuration, context)` and returns finite, acyclic JSON. Context provides `key`, `seed`, `attemptId`, `outputDirectory` and `writeArtifact(name, data)`. Convert exact BigInt money to canonical decimal strings for report JSON; do not lose precision by converting it to Number.

Keep useful immutable attempt artifacts: research plan, raw/source selection hashes, full configuration, split plan, per-fold model/scaler diagnostics, source/venue assumptions and summary reports referencing complete disk audits. Write unique names rather than mutating a published artifact. Recursive inventories include binary model hashes. Inline callback closure state cannot be reconstructed by the registry.

Use `runExperiment(root, configuration, work)` for synchronous tasks. It returns `{ id, result }`, registers an owned attempt, and publishes the same artifact/result inventory as queued work. Asynchronous code belongs in a worker/queue. A direct `runStrategy` or low-level backtest is not automatically a registered experiment; the CLI wraps its runs, but custom code must do so explicitly.

## Verify before comparing

Read with `readExperimentResult(root, key)` and check `verifyExperimentArtifacts(root, key)`. Use `listExperiments` to retain the complete population and attempt status. Keep dataset and build/protocol identities with the summaries; source/venue naming is not provenance evidence by itself.

Immutable hashes bind supplied inputs/content, not the truth of timestamps, installed dependency bytes or a hostile callback's behavior. Trusted worker code can still read files outside the declared dataset or train outside the registered pipeline. Explain that boundary rather than claiming sandboxed research.

## Basis

Local: `docs/RESEARCH.md`, `docs/CONTRACT.md`, `src/experiments.mjs`, `src/search.mjs`, `examples/parallel-research.mjs`.

Distilled from [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), [Parameters](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/parameters) and [Object Store](https://www.quantconnect.com/docs/v2/writing-algorithms/object-store). Immutable local attempts replace shared mutable vendor storage for research evidence.
