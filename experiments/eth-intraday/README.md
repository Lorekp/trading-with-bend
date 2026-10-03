# First ETH intraday screen

This study compares continuation and reversal using completed Binance minute
bars and independently supplied OKX execution inputs. Perpetual marks and funding
are admitted from processed data; fills use an explicitly assumed bar-volume
proxy. It is an exploratory development study, not a calibrated execution model.

The completed first run is described in
[the campaign report](../../docs/ETH_INTRADAY_CAMPAIGN_2026_10_03.md).

From the repository root, after installing dependencies and building:

```powershell
node experiments/eth-intraday/prepare-data.mjs data output/eth-intraday-inputs-new
node --test experiments/eth-intraday/worker.test.mjs
node experiments/eth-intraday/run.mjs output/eth-intraday-new-study output/eth-intraday-inputs-new/dataset.json --preflight-only
node experiments/eth-intraday/run.mjs output/eth-intraday-new-study output/eth-intraday-inputs-new/dataset.json
```

Preparation owns a new output directory.
Use a fresh study identity after changing code, inputs or assumptions; completed
registries and their frozen bundles remain the authoritative evidence. Reusing
the same data is still exploration, even with a new registry name.

The runner freezes its research plan before execution. It registers two cash
preflights, twelve base candidates, and stress trials for the six highest-return
valid base candidates. The stress-selection rule is declared before seeing
returns. Every job uses all three two-day folds, fresh accounts and cash/long/short
controls. Final partitions are empty, and this runner has no final-release path.

Each attempt retains a complete validation study, input provenance, disk audits,
and paired regular equity histories. `summary.json` retains every candidate's
status and reports an accept/reject decision separately from the official base
winner. Stress comparisons have their own campaign identity. The maximum is
twenty admissions, with two replay workers sharing one resource budget.

The initial run's frozen runner checked the 5% drawdown gate on base results;
post-run review also checked the same winner under stress, which passed that
gate. The current runner applies the gate to both scenarios. This correction
does not change the initial rejection or any recorded trading result; reproduce
the exact original orchestration from its retained frozen bundle if necessary.
