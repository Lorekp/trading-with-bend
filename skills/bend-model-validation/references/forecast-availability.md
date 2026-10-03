# Sequence forecasting and retrospective selection

## Reuse the local forecast seam

`sequenceSamples({ observations, schema, instrument, venue, sequenceLength, horizonSteps, intervalMs })` validates regular completed observations, builds oldest-first feature windows and mature forward-return labels, and binds the target instrument/venue/horizon. Its `latest` row lacks a label and can be used for inference. Historical windows may overlap; future labels may not enter training before maturity.

This constructor requires contiguous fixed-grid feature times equal to feature availability, with labels maturing at the declared future grid point. General delayed cross-venue joins can exceed that domain. Use an explicitly compatible sample design instead of relabeling native observation/publication times to bypass admission.

`fitForecast({ kind, training, validation, schema, contract, seed, parameters, runtime })` uses the verified fold artifacts. Existing kinds include zero, ridge, LightGBM and TCN; inspect current implementation/runtime support rather than reinstalling libraries or implementing another transport by default. `forecastRuntime` records the optional Python environment before enqueueing, and fitting/reload check it. Pin external requirements and datasets too.

`predictForecast({ model, rows, schema, contract, runtime })` loads weights/preprocessing and checks availability/target identity. It never fits. Numerical prediction quality and foreign-code behavior remain outside the Bend proof boundary. The local adapters store portable data/weights, not arbitrary pickle objects.

## Selection diagnostics are not past deployable signals

The forecast example uses validation labels for early stopping/model selection. Its validation predictions are consequently retrospective diagnostics. The saved model's availability floor is after the last consumed validation label; it cannot be used to create a supposedly historical strategy over those same decisions. A later unseen interval or a properly scheduled sequence of past-only fits is needed for executable prediction evidence.

That floor is a research chronology guard, not measured training latency. A trading replay must add actual or explicitly modeled computation/deployment delay and route forecasts into target decisions only after availability. Refitting on train plus validation before final evaluation is a separately recorded final model with updated lineage/availability; it is not the original validation-selected artifact.

Report forecast error against zero and ridge on the same target/selection population. `regressionMetrics`/saved prediction diagnostics do not include trading costs. A useful forecast can still be unprofitable after spread, fees, funding, delay and turnover. A Binance target relabeled Hyperliquid is not cross-venue validation; use target-venue prices and explicit as-of information joins.

## Resource and update behavior

The optional Python interface packs overlapping windows and copies JSON across subprocesses. It is a bounded CPU research interface, not a streaming live-training service. Check the configured worker/subprocess timeout and sample population before launching a larger fit. Preserve failures and seeds instead of retaining only successful randomized runs.

Scheduled retraining is explicit in local workers or `createBarStrategy`'s walk-forward ridge logic, with recorded training/deployment delays. The replay contract is synchronous; vendor asynchronous training callbacks and live event-order assumptions do not apply. A persistent model artifact does not serialize every mutable strategy state.

## Basis

Local: `docs/FORECASTING.md`, `docs/RESEARCH.md`, `src/sequence-data.mjs`, `src/forecast.mjs`, `src/bar-strategies.mjs`, `experiments/eth-forecast/worker.mjs`.

Distilled from [Training Models](https://www.quantconnect.com/docs/v2/writing-algorithms/machine-learning/training-models), [Popular Libraries](https://www.quantconnect.com/docs/v2/writing-algorithms/machine-learning/popular-libraries) and [Object Store](https://www.quantconnect.com/docs/v2/writing-algorithms/object-store). The distinction between selected validation forecasts and executable historical signals follows the local availability contract.
