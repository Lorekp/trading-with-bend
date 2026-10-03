# Profiling and improving quote replay

The quote benchmark keeps workload construction, process isolation, complete
evidence comparison and timing policy in `experiments/speed/`. Performance
changes belong behind the existing toolkit interfaces; do not add workload
switches or relax accounting, audit or inference obligations to make a candidate
faster.

## Separate profiling from measurement

`experiments/hillclimb/profile.mjs` reuses a saved benchmark execution request in
a new experiment registry:

```powershell
node experiments/hillclimb/profile.mjs <campaign>/attempts/measurement/quotes-variable-dense/0/baseline/execution/request.json output/profiles/new-registry
```

Run it from the checkout being profiled, with the profiling files present there.
The worker wraps the existing benchmark worker and publishes `profile.cpuprofile`
alongside its normal report and complete audit. It aggregates self samples by
source location and marks the result ineligible for timing inference. The entry
point preserves the saved protocol's heap setting, pins configuration, worker,
toolkit and data dependencies, and requires a fresh registry. Retain every
profiling attempt. Do not run profiling or tests alongside a timing comparison.

## Reuse behind existing interfaces

- `canonical` encodes object fields without temporary encoded-field arrays. Its
  private cache retains only sorted, escaped field names, never values. It holds
  at most 128 layouts, each with at most 64 fields and a 2,048-character layout
  identity. Other layouts use the same uncached encoding. Every call discovers
  current keys and reads current values.
- `freeze` avoids recursive calls on primitive fields. Its existing private
  deep-freeze brand still distinguishes reusable immutable objects from foreign
  shallow freezes.
- `QuoteExecutionVenue` freezes the events it creates so `Backtest` can reuse
  them through `immutableCopy`. Foreign mutable inputs retain fresh copies.
  Empty fill results get fresh empty arrays; nonempty results retain independent
  copies.
- `openReplayAudit` retains only its latest decoded series chunk. Nearby readers
  share deeply immutable values after matching stream, ordinal, count and payload
  bytes. Each reader still checks its own sequence, count and complete content
  digest. Closing the reader releases its private cache.

These implementation changes add no caller configuration, execution adapter or
parallel audit implementation. The existing modules own reuse and memory bounds
at their seams. Complete replay workflows remain the test surface, including
different-paced immutable readers and saved-request profiling with unchanged
timing samples.

## Validation and records

Run `npm test` and `npm run test:regression` for shared changes. Preserve Bend
laws, proofs, input domains and complete replay evidence. Build targets before
measurement, use separate fixed checkouts, and retain all attempted populations.
`experiments/hillclimb/release.json` is a frozen release protocol; use a fresh
output directory for every comparison.

Lower observed times do not override order-effect or drift diagnostics. Keep
`requires-review` reports diagnostic and preserve outliers. Correctness validation
and timing inference are separate conclusions. A reliable speed claim requires
an appropriately controlled host and the declared complete-pair decision policy.
See [the benchmark design](BENCHMARK.md).

Machine-specific reports, raw samples, audits and profiles belong in local
`output/` records. This document describes the implementation and workflow,
without publishing a machine-specific speed estimate.
