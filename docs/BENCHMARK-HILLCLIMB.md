# Quote replay hillclimb, 2026-10-03

This study optimizes fresh-process quote job completion against baseline commit
`72c3e1e903682af7eac7034167c7df77b1e62d93`. It keeps the two 200,000-quote
workloads, seeds, lookback, order density, execution assumptions, complete disk
audits and benchmark decision policy unchanged. Bend laws, proofs and generated
accounting implementations are unchanged.

## Design

The improvements stay behind existing interfaces:

- `canonical` builds object encodings without temporary encoded-field arrays.
  Its private cache retains only sorted, escaped field names, never values.
  It holds at most 128 layouts, each with at most 64 fields and a 2,048-character
  layout identity. Other layouts use the same uncached encoding. Every call
  discovers the current keys and reads current values.
- `freeze` avoids recursive calls on primitive fields. The existing private
  deep-freeze brand still distinguishes reusable immutable objects from foreign
  shallow freezes.
- `QuoteExecutionVenue` freezes events it creates. `Backtest` can reuse those
  through `immutableCopy`; foreign mutable inputs still receive fresh copies.
  Empty fill results get fresh empty arrays without cloning; nonempty results
  retain their independent copies.
- `openReplayAudit` retains just its latest decoded series chunk. Nearby readers
  can share deeply immutable values after matching stream, ordinal, count and
  payload bytes. Every reader still checks its own sequence, count and full
  content digest. Different-paced readers and reader closure retain their
  existing behavior. Closing the reader releases the private cache.

No optimization adds caller configuration, another execution adapter, or a
parallel audit implementation. The modules own the reuse rules and memory
bounds at the existing seams. Complete replay workflows remain the test surface.

## Profiling

`experiments/hillclimb/profile.mjs` reuses a saved benchmark execution request in
a new experiment registry. Its worker wraps the existing benchmark worker and
publishes `profile.cpuprofile` with the normal report and complete audit. It
aggregates self samples by source location, preserves configured heap settings,
and marks its result ineligible for timing inference. Dependencies and keys pin
the configuration, data, worker and toolkit. Every profiling attempt is retained.

After a benchmark campaign, run profiling separately from measurement:

```powershell
node experiments/hillclimb/profile.mjs <campaign>/attempts/measurement/quotes-variable-dense/0/baseline/execution/request.json output/profiles/new-registry
```

Run this command from the checkout being profiled, with the profiling files
present there. Do not profile or run tests alongside a timing comparison.

The initial profile attributed 18.7% of self samples to freezing and 20.3% to
canonical serialization and its field callback. Candidate changes were layered:

| Attempt | Implementation | Replay ms | Report ms |
| --- | --- | ---: | ---: |
| `baseline-v1` | Original implementation | 13,295.1 | 955.7 |
| `core-v1` | Encoding loop and primitive freeze traversal | 12,975.6 | 814.4 |
| `venue-v2` | Add owned-event and empty-fill reuse | 16,607.8 | 974.8 |
| `baseline-v2` | Original implementation, later host check | 17,273.4 | 1,002.6 |
| `chunk-v3` | Add latest-chunk reuse | 14,164.2 | 1,016.1 |
| `layout-v4` | Add bounded field-layout reuse | 14,992.7 | 1,165.2 |

These are profiler diagnostics, not independent performance estimates. Host
conditions changed, including a separate recurring five-worker, two-million-quote
benchmark. Do not rank candidates by these single wall times. The final profile
places canonical serialization at 14.6% of self samples and removes event cloning
from the leading hotspots. Every attempt retains the same counts and trace and
target identities; timed campaigns additionally compare all required evidence.

## Comparisons and validation

The five-pair A/A calibration completed every pair with equivalent evidence and
passed both diagnostic screens. Variable-case Q was 0.9918, interval
[0.9584, 1.0195]; constant-case Q was 0.9856, interval [0.9597, 1.0133]. Both
intervals include equal performance. Pilot results are diagnostic by policy.

The `core-v1` pilot completed all five pairs per case with equivalent evidence.
Q was 0.9553 for variable quotes and 0.9599 for constant quotes. During this run
the separate campaign started: both cases flagged target drift, and the variable
case also flagged order effects. The complete population is retained and does
not support a release conclusion.

The candidate passes `npm test` (136 passed, three optional data cases skipped)
and `npm run test:regression` (115 passed, one optional case skipped). Existing
replay tests now also cover a lagging immutable reader across all chunks and the
saved-request profiling workflow, including unchanged timing samples.

`experiments/hillclimb/release.json` freezes the release settings before final
measurement. `experiments/hillclimb/results.json` preserves the reports and all
raw samples for the calibration and timed candidate populations. Complete local
registries, reports, audits and profiles remain under
`output/hillclimb-2026-10-03T15-43-08.705Z-94b64159-c838-429b-bad1-0f69cf6f52f0/`.
Each run has a fresh output directory; failed or suspect populations are retained.

Final timing waits for the competing benchmark to exit. This record will be
updated with the separately measured final population and its diagnostics.
