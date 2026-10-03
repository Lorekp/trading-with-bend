# Backtesting research

Reproducible strategy research separates available information from execution
assumptions and retains the evidence needed to explain every result.

## Language

**Information source**: Observations a strategy may know at a decision time,
including their publication times and declared units.

**Execution venue**: The model that turns target positions into orders, fills,
fees, funding, collateral requirements and account valuations.

**Admitted dataset**: An immutable market history whose identity, units,
chronology and required coverage have passed the declared validation rules.
Admission does not establish vendor completeness or realistic fills.

**Replay audit**: The complete accepted event, order, fill and valuation history
that explains a replay result, together with its content identity.

**Evaluation window**: The decision interval scored under a study protocol,
separate from preceding information used to initialize observations or marks.

**Study protocol**: The frozen rules for evaluation windows, account resets,
warmup, metric sampling, baselines and selection using validation data.

**Frozen experiment**: A trial whose configuration, worker, declared helpers
and input snapshots are admitted together as immutable execution evidence.
Later edits to the original sources do not change the admitted trial.

**Completed validation fold**: Candidate and baseline replay results for one
evaluation window whose identities, baseline population, replay audits and
metrics agree with the study protocol. Reusing a result requires the same
admission rules as a fresh evaluation.

**Final release**: The single authorized evaluation of the final partition after
the strategy and study protocol have been fixed.
