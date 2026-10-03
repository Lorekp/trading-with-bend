# Training-only fitting and checked model artifacts

## Partition before fitting

`walkForwardSplits(samples, options)` uses unique chronological sample IDs, decimal-string times, feature availability and `labelAvailableAt`. Set `finalStart` to reserve the final tail. Training features and labels must be strictly earlier than the validation boundary minus `embargoMs`; equality is excluded. Validation data/labels reaching the first final observation are also purged. Inspect `purged` and `validationPurged`, and accept an empty-fold error rather than bypassing maturity rules.

`foldRows(samples, plan, foldId, 'train', 'train')` returns a verified training partition artifact. `foldRows(..., 'select', 'validation')` returns the matching selection artifact. Pass them directly to fitting/evaluation. Do not retag validation rows, reconstruct hashes, or slice `.rows` and pretend the resulting object retained verified lineage. `evaluateStudy` supplies the same admitted artifacts in its callback.

A data-based normalizer, winsorization threshold, imputer, feature selector or PCA basis is fitted state. Fit it only on the permitted training population, save it with the model, and apply it unchanged to evaluation. A transform computed over the whole dataset leaks even if labels are later split correctly.

## Existing baseline APIs

`fitStandardScaler({ training, schema })` binds ordered schema, fold, exact training partition/hash, cutoff, means/scales and zero-variance handling. `fitRidge({ training, schema, trainingStartedAt, trainingCompletedAt, deployedAt, alpha, scaler })` fits or accepts a scaler tied to that same partition. The objective penalizes standardized coefficients, not the intercept. Numerical routines are tested, not formally proved.

`predictRidge({ model, feature, schema, fold, decisionTime })` checks artifact content, schema, fold and availability. `evaluateRegression({ model, evaluation, schema })` consumes verified evaluation artifacts, never fits, rejects training IDs, and uses predeclared row decision times. Declare any decision delay in the samples before forming the split plan; modifying partition rows afterward invalidates them.

For online fitting without a split plan, `trainingWindow(rows, { fold, cutoff })` explicitly declares that separate origin; rows must already be `train`. Its paired `evaluationWindow(rows, { training })` binds validation to that exact window. Do not advertise this as membership in a held-out walk-forward plan.

## Availability chain

Label maturity comes before training use; training start, completion, deployment and decision follow in order. The exclusive fitting cutoff additionally requires features/labels strictly before that cutoff. Save truthful timestamps and account for computation/deployment latency rather than assigning all steps the feature timestamp.

For external estimators, `validateModelArtifact(artifact, schema, decisionTime)` checks the supplied schema hash, actual model/preprocessor hashes, matching fold and chronology. It does not inspect arbitrary foreign training or attest that supplied timestamps/hashes are truthful. Retain actual model bytes, preprocessing, feature definitions, runtime/version information and the training population for independent review.

## Basis

Local: `docs/RESEARCH.md`, `docs/CONTRACT.md`, `src/evaluation.mjs`, `src/features.mjs`, `src/models.mjs`, `src/research.mjs`.

Distilled from [Training Models](https://www.quantconnect.com/docs/v2/writing-algorithms/machine-learning/training-models), [Research Guide](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide) and [Walk Forward Optimization](https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization). The artifact/purge contracts are local counterparts, not a vendor training API.
