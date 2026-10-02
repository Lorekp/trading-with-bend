import { loadBinanceBars, walkForwardSplits, foldRows, fitForecast, hash } from '../../src/index.mjs';
import { ethForecastData, fixtureBars } from './data.mjs';

export default async function experiment(configuration, context) {
  const { kind, manifestPath, datasetSeed = 41, maxBars = 1440, parameters = {}, python, environment } = configuration;
  if (!Number.isSafeInteger(maxBars) || maxBars < 240) throw new Error('maxBars must be at least 240');
  const loaded = manifestPath ? await loadBinanceBars({ manifestPath, intervalMinutes: 1 }) :
    { bars: fixtureBars(maxBars, datasetSeed), provenance: { fixture: true, datasetSeed } };
  const { samples, schema, contract, dataHash } = ethForecastData(loaded.bars.slice(0, maxBars), manifestPath ? 'binance-usdm' : 'synthetic');
  const trainSize = Math.floor(samples.length * 0.6), finalStart = Math.floor(samples.length * 0.8);
  // The split module purges labels reaching final data using their actual availability.
  const validationSize = finalStart - trainSize;
  const plan = walkForwardSplits(samples, { trainSize, validationSize, finalStart, stepSize: samples.length });
  const fold = plan.folds[0];
  const training = foldRows(samples, plan, fold.id, 'train', 'train');
  const validationPartition = foldRows(samples, plan, fold.id, 'select', 'validation');
  context.writeArtifact('split-plan.json', plan);
  context.writeArtifact('data.json', { dataHash, provenance: loaded.provenance, contract, schema, datasetSeed,
    forecastRows: samples.length, finalRows: plan.final.length, finalReleased: false });
  const { model, validation } = fitForecast({ kind, training, validation: validationPartition, schema, contract,
    seed: context.seed, parameters, runtime: { python, environment, timeoutMs: 240000 } });
  context.writeArtifact('model.json', model);
  context.writeArtifact('validation.json', validation);
  return { kind, dataHash, splitHash: hash(plan), validationTimesHash: hash(validationPartition.rows.map(row => row.time)),
    trainingRows: training.rows.length, validationRows: validationPartition.rows.length, finalRows: plan.final.length, finalReleased: false,
    mse: validation.mse, rmse: validation.rmse, mae: validation.mae, modelHash: model.hash,
    scope: 'Forecast selection diagnostics only; no trading, execution, profitability or final-test claim' };
}
