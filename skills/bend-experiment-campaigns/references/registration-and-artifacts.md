# Registration and repeatable evidence

## Official campaign admission

Name one coordinator to own the research plan, common data/splits/controls, cross-campaign trial allocation, host resource budget and reporting. After a small preflight `evaluateStudy` establishes `datasetHash`, `planHash`, `comparisonHash` and `protocol`, create the immutable specification with `createCampaign(root, specification)`. Include `maxTrials`, `resourceBudget` and one absolute `finalAuthorityDirectory` shared across campaign roots/checkouts. Keep the authority separate from exploration registries and attempt files.

Submit workers with `campaign.submit(job)`, then close membership with `campaign.seal()` and run through `campaign.run(options)`. Independent submitters may share this seam. Every accepted key consumes trial budget, including failed/cancelled/abandoned work. Admission errors before reservation consume no slot; an interrupted reservation stays visible until matching registration completes. The coordinator counts separate stress campaigns and prior/manual searches as well: one campaign's `maxTrials` is not a global research budget.

`campaign.report()` is authoritative. Selection stays `null` until membership is sealed and every admission is registered and terminal. Completed studies must match common data/plan/protocol/comparison identities. The immutable report selects exact aggregate validation return with lexical trial-ID tie breaking. Apply the research plan's separate accept/reject rule to this winner; a custom ranking or post-results filter cannot replace it for official final release.

## Freeze workers and external inputs

Build and verify once before admission. Official submissions freeze verified toolkit/build files, installed locked package contents, worker entrypoint and declared helpers. Helpers must be regular files inside `sourceRoot` (the active toolkit checkout by default); arbitrary external transitive imports are not inferred. Declare every required helper. Frozen installed bytes establish integrity, not trustworthy package behavior.

External data/models/manifests/shards use `inputFiles`, mapping configuration JSON pointers to matching path strings, for example `{ '/data/file': absolutePath }` for `configuration.data.file`. Only those fields are rewritten to immutable copies; a path hidden in another string is not automatically captured. Snapshot every selected external file needed to reproduce execution. Original files changing later do not change frozen queued work. Preserve bundle/input stores with the registry; descriptors alone are not portable evidence.

`workerIsolation: 'filesystem'` is the default: workers read their bundle, declared snapshots and own job history, and write their own attempt/claim. Child processes, native addons and worker threads are unavailable. Foreign/Python training requires a separately frozen `workerIsolation: 'trusted'` campaign with ordinary process/filesystem access. Neither mode proves hostile-code isolation or network safety.

The coordinator supplies train/validation-only values, including in configuration, helpers and bundled files. Denying files inside final authority cannot detect final values embedded elsewhere. `evaluateStudy` admits all supplied samples, so role-gated helpers do not hide their final rows. Preserve full sample/plan identity when preparing safe inputs: if samples are metadata-only IDs/timestamps, keep final market values in a separate coordinator-owned store; otherwise verify a supported partition-artifact workflow rather than simply slicing or editing a hashed plan. `releaseCampaignFinal` requires the original frozen samples/plan identity.

## Lower-level diagnostics

`gridJobs({ namespace, workerModule, baseConfiguration, space, dependencies, maxTrials, seed })` generates validation-only jobs. Enqueue each through `enqueueExperiment(root, job)` and execute `await runQueue(root, { concurrency, timeoutMs })`. Seeds are deterministic from keys unless declared; record dataset seeds separately from model/trial seeds.

For raw queues, record split/evaluation choices, model runtime and dataset seeds. Explicitly declare helper modules, datasets, processed manifests plus shards/databases, requirements/lockfiles and model files as dependencies. Unfrozen workers pin and reject mutable-source/runtime drift rather than executing campaign snapshots.

`gridJobs` hashes configuration and seed to form its key. Worker or dataset edits do not magically give that key a new meaning. Change the namespace/version when changing code or data, and keep old registries with the original checkout. A deliberate retry is an attempt in the same immutable specification only through supported recovery; a changed hypothesis/configuration is a new trial.

## Worker contract

Place the worker and helpers under `experiments/<study>/`. A worker exports `default async function(configuration, context)` and returns finite, acyclic JSON. Context provides `key`, `seed`, `attemptId`, `outputDirectory` and `writeArtifact(name, data)`. Convert exact BigInt money to canonical decimal strings for report JSON; do not lose precision by converting it to Number.

Official workers return a complete `validation-study-v1` from `evaluateStudy`, directly or as `{ study, ...otherResults }`; a development summary alone is insufficient. The campaign reserves `configuration.campaign` metadata. Keep immutable research plan, source-selection identity, configuration, split plan, model/scaler diagnostics and reports referencing complete disk audits. Preserve regular paired candidate/control return evidence when planned inference needs it; streaming study summaries alone are not the panel. Write unique artifact names. Recursive inventories include binary model hashes; inline closure state cannot be reconstructed.

Use `runExperiment(root, configuration, work)` for synchronous tasks. It returns `{ id, result }`, registers an owned attempt, and publishes the same artifact/result inventory as queued work. Asynchronous code belongs in a worker/queue. A direct `runStrategy` or low-level backtest is not automatically a registered experiment; the CLI wraps its runs, but custom code must do so explicitly.

## Verify before comparing

Read with `readExperimentResult(root, key)` and check `verifyExperimentArtifacts(root, key)`. Use `listExperiments` to retain the complete population and attempt status. Keep dataset and build/protocol identities with the summaries; source/venue naming is not provenance evidence by itself.

Official reports verify completed results and supplementary artifacts before selection. Immutable hashes bind frozen input/package bytes, not timestamp truth, complete vendor capture or honest training. Trusted worker code can read outside declared datasets or train outside the registered pipeline; retain that boundary in conclusions.

## Basis

Local: `docs/RESEARCH.md`, `docs/CONTRACT.md`, `src/campaigns.mjs`, `src/campaign-final.mjs`, `src/worker-bundle.mjs`, `src/experiments.mjs`, `src/search.mjs`, `tests/e2e/swarm.test.mjs`.

Distilled from [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide), [Parameters](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/parameters) and [Object Store](https://www.quantconnect.com/docs/v2/writing-algorithms/object-store). Immutable local attempts replace shared mutable vendor storage for research evidence.
