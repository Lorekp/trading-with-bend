# Small ETH return-forecasting example

The optional forecasting module compares zero return, ridge, LightGBM and a
causal PyTorch TCN on the same 60 completed minute observations, predicting
`log(close[t+5] / close[t])`. It does not submit orders. Forecast error is separate
from profitability, fees, spread, slippage, funding and execution realism.

## Run

Use the repository's usual Bend setup first. Python 3.12 is the tested ML
interpreter; dependencies are optional for the rest of the toolkit.

```powershell
python -m venv .tools/ml-venv
.tools/ml-venv/Scripts/python.exe -m pip install -r requirements-ml.txt
$env:ML_PYTHON = (Resolve-Path .tools/ml-venv/Scripts/python.exe).Path
npm run ml-demo
npm test
npm run test:regression
```

On POSIX use `.tools/ml-venv/bin/python` and `export ML_PYTHON=...`.
The Python environment must be installed before queueing. The example records
Python and library versions in every immutable job configuration and checks them
again during fitting and artifact reload. Version recording does not hash every
installed package file or guarantee numerical identity across machines.
Models also bind the Python implementation's content hash; changing the TCN
architecture requires fitting a new artifact rather than silently reinterpreting
existing weights.

The default demo uses 600 deterministic synthetic minutes to exercise the
pipeline. It prints a unique registry path and retains all four trial outcomes,
including failures. For real data, supply an existing verified Binance manifest:

```powershell
npm run ml-demo -- output/eth-forecast-study-v1 data/binance/um/ETHUSDT/2026-09/manifest.json 1440
```

The final argument limits the selection to the first N bars (default 1440 with
a manifest). Use 43200 for the full month only after validating the small run.
Packing all overlapping windows uses memory proportional to samples × 60 ×
features, and the JSON subprocess transport makes additional copies. This is a
small CPU research interface, not a streaming or low-latency inference runtime.
The subprocess timeout is four minutes per worker; the queue timeout is five.
Use a new study registry after changing code, data or configuration.

## Module interface and seam

`src/index.mjs` exports:

- `sequenceSamples`: validates a regular, completed observation stream, packs
  oldest-first feature windows and attaches future log-return labels. It binds
  feature names, definitions, order, units, window length and forecast target.
  Its `latest` row has no label and can be used for inference without waiting
  for a future price; `samples` contains only rows whose labels have matured.
- `fitForecast`: accepts `training` and `validation` partition artifacts from
  `foldRows`, schema and target contract. Fold identity and exclusive cutoff come
  from those artifacts; different datasets or split plans cannot be mixed.
  It returns a portable JSON model and retrospective
  validation diagnostics. The `kind` selects zero, ridge, LightGBM or TCN.
- `predictForecast`: reloads saved weights and preprocessing, checks the schema,
  target and availability, and returns instrument, venue, timestamp, horizon,
  predicted log return, model hash and feature hash. It never fits.
- `forecastRuntime`: snapshots the optional Python environment before enqueueing.

The model seam sits behind fitting and batch prediction. The adapters share the
existing feature-artifact validation and training-only scaler. Python owns the
numerical estimators, tensor layout, early stopping and weight serialization.
JSON stores tensor arrays, ridge coefficients or native LightGBM model text;
there is no pickle deserialization. This keeps preprocessing and availability
rules local to one module without adding execution responsibilities.

Ridge uses scikit-learn's iterative solver for the 360-column sequence design;
the existing small `fitRidge` interface and implementation remain available for
ordinary low-dimensional research. All four adapters receive identical flattened
windows; the TCN reshapes them to batch × feature × time. Each lag/feature column
is standardized using only training rows. Targets use training mean and standard
deviation; constant columns/targets use scale 1. Outputs are converted back to
log-return units. Zero predicts exactly no price change.

For another study, put its worker under `experiments/<study>/`, obtain fitting
artifacts with `foldRows(..., 'train', 'train')` and
`foldRows(..., 'select', 'validation')`. Pass them directly as `training` and
`validation`; their `.rows` are already tagged. Pin
`requirements-ml.txt`, worker helpers and datasets in `dependencies`; the registry
automatically pins shared JavaScript and Python modules recursively under `src`.
Save the returned model and diagnostics using `context.writeArtifact`.

## Information and chronology

The example's six features are log returns over 1, 5 and 15 minutes, log1p ETH
volume, high-low range divided by close, and trailing 15-minute population
standard deviation of one-minute log returns. It uses the existing strict
one-minute OHLCV adapter and rejects gaps. The initial 15 observations build
trailing returns; volatility then warms up before collecting 60 ready features.
Availability is inclusive bar close + 1 ms.

Trade count, taker pressure, funding and mark/index context are omitted. They
require their own timestamp-safe sources; trade pressure is not book imbalance.
The target is explicitly `binance-usdm/ETHUSDT` for archive data and `synthetic`
for fixtures. A Hyperliquid study needs Hyperliquid target prices and an explicit
as-of join with any Binance information. Relabeling a venue is not transfer
validation.

The example uses the first 60% of labeled samples for the training region, a
later validation region, and reserves the last 20% for final testing. The shared
split module purges training labels reaching validation, including equality.
The split module also purges validation labels reaching the first final
observation, including equality. With this five-minute horizon it excludes five
samples and records them in `validationPurged`. Input histories may overlap;
historical context is allowed, future labels are not.

Early stopping selects on validation labels. Consequently validation predictions
are retrospective selection diagnostics, not forecasts that were executable
at those timestamps. The saved model's earliest availability is one millisecond
after the last validation label. This is a research availability floor, not a
measured training/deployment latency. `predictForecast` rejects earlier requests.
A live strategy must additionally account for actual computation and deployment.
Each sequence row, including `latest`, carries the target contract hash. Fitting
and prediction verify that hash against the declared instrument, venue, sequence
shape and horizon. Mixing rows from another target contract is rejected even
when feature schemas match. This records the caller's declared target; it does
not attest to the origin of vendor prices.

For final metrics, freeze the model/protocol and obtain final rows only inside
`withFinalHoldout`; the demo never consumes that gate. As elsewhere in this
toolkit, the gate is cooperative, not a sandbox against direct data access.

## Model defaults and checks

The TCN has four residual blocks, each with two left-padded convolutions, 32
channels, kernel size 3, dilations 1/2/4/8, ReLU and dropout 0.1. It reads the last
encoded step through a 32→16→1 head. Its receptive field is 61 steps. Training
uses CPU, one thread, AdamW (learning rate 0.001, weight decay 0.01), batches of
128, standardized-target MSE, at most 20 epochs and patience 4. Best validation
weights are restored. Six features give fewer parameters than the roughly 24k
16-feature design; the exact count is saved in diagnostics.

LightGBM starts with 100 trees, 15 leaves, learning rate 0.05 and patience 10;
ridge uses alpha 1. Settings and seed 41 are examples, not optimized claims.
Validation artifacts include MSE, RMSE, MAE and every predicted return. Each
attempt saves the split plan, data provenance, model, runtime and diagnostics.

With `ML_PYTHON` set, the existing `tests/ml-execution.test.mjs` runs real fits
for all adapters, artifact reloads, training-only scaler checks, TCN prefix
causality, chronology rejection, persistent final-release checks, a registered
four-model campaign, a deliberately failed trial and artifact tampering. Without
that variable, only optional Python integration is skipped; sequence/purge tests
still run. No ML numerical behavior or vendor data is formally proved.

Implementation references: [PyTorch Conv1d](https://docs.pytorch.org/docs/2.8/generated/torch.nn.Conv1d.html),
[the original TCN reference](https://github.com/locuslab/TCN/blob/master/TCN/tcn.py),
and [LightGBM early stopping](https://lightgbm.readthedocs.io/en/v4.6.0/pythonapi/lightgbm.early_stopping.html).
The small TCN is an independent implementation of the requested architecture;
it does not reproduce every training/detail choice in the reference.
