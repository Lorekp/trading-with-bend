# Futures and perpetual backtesting

`DerivativeExecutionVenue` implements the existing execution venue interface for
one linear or inverse contract and one settlement currency. Compose it with
`InformationSource`, `runStrategy` and signed `targetPosition` signals. The venue
owns fees, funding, margin, orders, FIFO positions, liquidation and settlement.
The cash venues retain their original input domain and reject short targets.

This is an explicit research model, not an exchange emulator. Supplied parameters
do not implement a named exchange's risk tiers, liquidation auction or clearing
rules. See the exact assumptions below before comparing a strategy to live fills.

## Run a reproducible study

Build once, then run the synthetic baseline grid:

```powershell
npm run build
node examples/derivatives.mjs output/inverse-perp inverse perpetual
node examples/derivatives.mjs output/linear-future linear future
```

`npm run derivatives-demo` builds and runs the default inverse perpetual study.
Use `BEND_WSL_DISTRO` on Windows if the installed distribution differs from the
repository default. For example, `$env:BEND_WSL_DISTRO='Debian'`.

Each study queues short, flat and long baselines on the same deterministic data,
with the same purged walk-forward windows. Each validation window starts with
fresh collateral. Artifacts contain the split plan, dataset hash, partition and
complete reports. Selection sums validation net P&L in one settlement currency;
it does not compare coin P&L to quote P&L. Failures remain in the registry and
printed population. These are plumbing fixtures, not profitability evidence.

Release the final tail once, after choosing by validation:

```powershell
node examples/derivatives.mjs output/inverse-perp inverse perpetual --final
```

The final result is both a registered experiment and a persistent
`withFinalHoldout` artifact. Repeating final release fails. Changing shared code
requires a new study directory/identity; existing manifests reject drift.

For your own normalized data, enqueue
`experiments/derivatives/worker.mjs` through `gridJobs`. Its base configuration is
`{datasetPath, config, split}` and its parameter space is
`{targetLots: ['-2', '0', '2']}`. The dataset JSON contains `{data, samples}`;
samples follow `walkForwardSplits` (`id`, `time`, `availableAt`,
`labelAvailableAt`). Declare the dataset path in `dependencies`. A model worker
can reuse `evaluateWindow` or compose the venue directly; fitting must still use
`foldRows(..., 'train', 'train')`. The supplied constant baseline does not train.

## Interface and units

```js
import {
  DerivativeExecutionVenue, InformationSource, runStrategy, targetPosition,
} from './src/index.mjs';

const config = {
  instrument: { symbol: 'BTC-INVERSE-PERP', currency: 'BTC', lotSize: '1', priceTick: '1' },
  contract: {
    kind: 'perpetual', payoff: 'inverse', contractValue: '100',
    settlementScale: '100000000', fundingIntervalMs: '28800000', fundingOffsetMs: '0',
  },
  initialCash: '10000000', maxPositionLots: '1000',
  initialMarginBps: '1000', maintenanceMarginBps: '500',
  feeBps: '5', liquidationFeeBps: '100', slippageBps: '10',
  orderLatencyMs: '100', cancelLatencyMs: '100',
  maxQuoteAgeMs: '1000', maxMarkAgeMs: '1000',
};
// Normalized data and observations must be supplied independently.
const venue = new DerivativeExecutionVenue({ id: 'my-venue/snapshot-v1', config, data });
const source = new InformationSource({ id: 'my-signals/snapshot-v1', instrument: config.instrument, observations });
const report = runStrategy(source, venue, targetPosition('-2')).report();
```

Every numeric configuration/event field is a canonical decimal string, including
millisecond times and basis points. Targets and funding rates may be negative;
`-0`, fractional lots and noncanonical integers are rejected. Public money and
quantities in JSON reports are strings. Snapshot values are BigInts.

| Field | Meaning |
| --- | --- |
| `instrument.currency` | Collateral/settlement currency, **not** automatically the price quote currency |
| `instrument.lotSize` | Canonical contract-lot descriptor, agreed explicitly with the signal source |
| `instrument.priceTick` | Positive integer executable price increment |
| Linear `price` | Settlement minor units per underlying multiplier unit |
| Linear `contractValue` | Positive integer multiplier per lot; use 1 when prices are already per lot |
| Linear `settlementScale` | Must be 1 |
| Inverse `price` | Quote units per one underlying coin |
| Inverse `contractValue` | Fixed quote value per lot, in the same quote units as price |
| Inverse `settlementScale` | Settlement minor units per coin (e.g. satoshis per BTC) |
| `feeBps` | Nonnegative proportional taker fee, charged at every fill including settlement |
| `liquidationFeeBps` | Additional proportional charge on liquidation |
| `slippageBps` | Decision-time limit collar; also adverse liquidation-price adjustment |

If inverse price and contract value are both in USD cents, scale both together.
No floating-point rescaling, implicit currency conversion or multiplier inference
occurs. Linear fractional multipliers must be normalized upstream to integer
per-lot prices. Source identity/units must match the venue explicitly; reusing an
underlying ticker does not normalize a spot source into a derivative contract.

For signed closed lots `q`, multiplier `v`, entry `a`, exit `b`:

- Linear P&L: `q * v * (b - a)`.
- Inverse P&L: `q * v * settlementScale * (b - a) / (a * b)`.
- Linear settlement notional: `abs(q) * v * price`.
- Inverse settlement notional: `abs(q) * v * settlementScale / price`.

All products/divisions use exact BigInt arithmetic. Inverse P&L rounds down per
FIFO slice, including losses away from zero. Fees and margin round up. Funding
transfers round away from zero in either direction. Therefore splitting a fill
can affect minor-unit rounding; the complete FIFO/fill audit is authoritative.
There is no average-entry-price rounding. Unrealized P&L marks each remaining
FIFO slice with the same rule, and contributes to terminal equity.

The Bend wallet holds separate cumulative credit/debit totals, each bounded by
`2^48 - 1`. Cash is their signed difference. Deficits survive reconciliation;
negative collateral is never saturated to zero. Price, quantity and individual
posting magnitudes are bounded too; rational intermediate products use BigInt.

## Dataset admission and event order

`data` is `{startTime, endTime, events}`, with inclusive coverage. Import
`validateDerivativeData` directly from `src/derivative-data.mjs` for admission
without a generated Bend runtime. Every event has:

```js
{ id: 'unique', type: 'mark', time: '1000', sequence: '1', sourceTime: '1000',
  symbol: 'BTC-INVERSE-PERP', currency: 'BTC', price: '60000' }
```

| Type | Additional fields | Effect |
| --- | --- | --- |
| `quote` | `bid`, `ask`, `bidLots`, `askLots` | Fresh executable prices and new per-side liquidity budgets |
| `mark` | `price` | Risk/equity mark; checks maintenance margin |
| `funding` | `price`, signed `ratePpm` | Funding settlement price and rate in millionths, for the current position |
| `settlement` | `price` | Mandatory full cash settlement at dated-future expiry |

Events must have nondecreasing timestamps and strictly increasing sequences;
`sourceTime` must equal `time`. No sorting or interpolation occurs. Identical
duplicate IDs are ignored; changed duplicates fail. Off-tick/crossed quotes,
cross-instrument events and decision times outside coverage fail.

A perpetual requires exactly one funding event at every
`fundingOffsetMs + n * fundingIntervalMs` within coverage, including explicit
zero rates. Missing data never means zero funding. Positive rates debit longs
and credit shorts; negative rates reverse this. Funding uses its supplied
settlement price, not the trade quote; liquidation still uses the risk mark.
The model uses one fixed funding schedule per dataset.

A future declares `expiryTime` instead of funding interval/offset. Funding events
are rejected. Coverage containing expiry requires exactly one settlement event at
expiry. Open positions settle there, working orders are cancelled, and no new
orders/fills are admitted at or after expiry. There is no physical delivery or
implicit rolling into a second contract.

Sequence determines the order of equal-time mark, funding, quote and settlement
events. Supply truthful venue ordering; all events at a decision timestamp run
before its signal. Cancellation effective at an event wins the tie. Fills require
strictly newer timestamps than decisions and must satisfy arrival latency and
the limit. They execute at the supplied quote, without a second slippage debit.

## Margin, orders and liquidation

One single-instrument account shares its collateral across its net position and
at most one working order. There is no hedge mode, multi-asset portfolio margin
or collateral transfer. Require `0 < maintenanceMarginBps < initialMarginBps <=
10000`. Initial/maintenance requirements use settlement notional at the risk mark.

Targets are signed net lots. Cap breaches and insufficient margin are recorded
rejections; targets are not silently downsized. Admission considers full target
exposure, adverse execution at the limit, realized/unrealized P&L and fees.
Snapshots expose initial margin, pending-order reserve and available collateral.
When a target changes, the venue requests cancellation and waits for it to become
effective before replacing the order. Another signal is needed after delayed
cancellation. In-flight partial fills remain possible. Repeated identical targets
do not stack exposure. `null` leaves working orders alone.

Each fill rechecks margin at its actual price and quantity; a no-longer-feasible
order is cancelled with an audited rejection. Pure reductions remain allowed
below initial margin. Reversals close FIFO lots before opening the opposite side.
No mark or a stale mark prevents new fills; stale terminal/open-position
valuations invalidate ordinary performance rather than silently dropping losses.

Equity at or below maintenance margin triggers full liquidation, including after
funding or fees. Liquidation closes at the risk mark adjusted adversely by
`slippageBps`, rounded adversely to price tick, and charges both ordinary and
liquidation fees. It bypasses supplied quote liquidity: this explicit stress
assumption is **not** an exchange auction simulator. The account halts afterward.
Losses beyond collateral remain a reported deficit; there is no insurance-fund,
ADL or bankruptcy-price forgiveness. Intramark moves cannot be reconstructed.

Dated futures realize P&L on close/expiry in this model. Daily clearing variation
payments are not separate cash-flow events; marked equity includes open P&L.
Perpetuals do not expire. Ending a replay leaves open positions and working orders
visible and never drains future events or forces an exit. Derivative continuation
currently requires deterministic replay from the retained dataset/signals;
the cash engine's checkpoints do not serialize this venue.

## Validation and verification scope

Reports retain complete orders, fills, postings, valuations, source/config/data
hashes, build evidence, rounding and liquidation assumptions. They reconcile
`cash = initialCash + realizedPnl + funding - fees` and
`equity = cash + unrealizedPnl`. Valuations include market events and decision
times between events (with `eventId: null`). A stale open-position valuation
invalidates performance even if a later mark restores fresh equity. Drawdown is
absolute settlement money sampled at these times. No annualized Sharpe is
inferred from irregular event timestamps. Existing
`regularReturns` requires explicitly regular, nonnegative equity samples; it does
not accept bankruptcy deficits or silently resample this event trace.

`npm test` covers linear/inverse execution, independent rational P&L checks,
long/short funding, FIFO partial closes/reversal, cancellation latency, margin
rejection, liquidation deficits, expiry and malformed/missing data, plus queued
validation and single-use holdout release. `npm run test:regression` retains the
cash, research, concurrency and integrity regressions.

The two derivative Bend laws specify exact independent credit/debit posting and
zero-posting identity. Existing Bend order eligibility, fill and cancellation
primitives are reused. A negative proof test drops a debit and must fail. These
laws do not prove the host's reciprocal-price formulas, margin admission,
liquidation economics, vendor data or research results. Those have independent
tests and runtime checks; the report states this narrower scope.

Economic references: [Bybit funding calculation](https://www.bybit.com/en/help-center/article/Funding-fee-calculation)
describes position-value funding transfers; [CME money calculations](https://www.cmegroup.com/education/articles-and-reports/money-calculations-for-futures-and-options)
describes clearing variation payments. Their exchange-specific mechanics are not
automatically implemented by this research venue.
