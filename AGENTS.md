# Working in this research workspace

Use `src/index.mjs` or the focused modules in `src/` before writing duplicate
accounting, execution, feature, sizing, split, metric or registry code.

## Experiments

- Put new strategy workers and their helpers under `experiments/<agent-or-study>/`.
  A worker exports `default async function(configuration, context)` and returns
  JSON. Use `context.writeArtifact(name, data)` for immutable attempt artifacts.
- Register runs with `enqueueExperiment` / `runQueue`. Give each study a stable
  namespace and each configuration a distinct key (`gridJobs` does this).
  Declare external files/imports/datasets in `dependencies` so queued work detects
  changes. Do not reuse a key for changed code, data, seeds or configuration.
- Multiple agents may share one registry on a local filesystem. Worker limits
  apply per runner. Never remove a claim to take ownership from a live process.
  Use explicit `recoverExperiment` only after the owner and supervisor are dead.
- Use the same dataset seed/snapshot and evaluation windows for comparisons.
  Trial/model seeds can differ but must be recorded. Keep failed and abandoned
  attempts in the population; do not report only winners.
- Train on `foldRows(..., 'train', 'train')`, select on validation, and release
  final data only through `withFinalHoldout`. The gate is cooperative, not a
  sandbox against direct reads or creating another holdout name.

## Shared code and verification

- The exact ledger, matching and research policy core is Bend. Preserve the
  declared input domain and strengthen laws when extending critical behavior.
  Keep LAWS.bend/specification changes separate in review from implementations
  and PROOF.bend; never weaken a law merely to make a change pass.
- Coordinate edits to shared modules. Queued jobs pin toolkit/worker/dependency
  hashes and intentionally reject changes. Use a separate checkout/version when
  changing shared infrastructure during a long experiment campaign.
- Build once before starting a campaign. Build locking prevents simultaneous
  writers; a stale lock requires checking that its recorded PID has exited.
- Run `npm test` after shared changes. It checks the Bend laws/kernel when Lean
  is present, reference comparisons, deliberate broken-proof cases and actual
  multiprocess races. Run `npm run research-demo` for the complete rules/ML path.
- Do not claim floating-point model metrics, vendor data, queue realism, foreign
  code or callback isolation are formally proved. See docs/CONTRACT.md and
  docs/RESEARCH.md for the precise boundaries.
