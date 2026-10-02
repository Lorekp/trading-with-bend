// Shared worker example: identical data/evaluation windows for rules and ML.
import { syntheticQuotes } from '../src/data.mjs';
import { computeFeatures } from '../src/features.mjs';
import { fitRidge, predictRidge, evaluateRegression } from '../src/models.mjs';
import { walkForwardSplits, foldRows } from '../src/evaluation.mjs';
import { buyAndHold, movingAverageCrossover, meanReversion, targetPosition } from '../src/strategies.mjs';
import { runStrategy, hash } from '../src/framework.mjs';

export default async function experiment(configuration, context) {
  const { kind, datasetSeed = '41', parameters = {}, evaluationPartition } = configuration;
  if (evaluationPartition !== 'validation') throw new Error('This search worker evaluates validation only');
  const instrument = { symbol: 'SYNTH', currency: 'EUR', priceTick: '1', lotSize: '1' };
  const ticks = syntheticQuotes({ instrument, count: 140, seed: datasetSeed, stepMs: '10', initialBid: '1000', spreadTicks: '2', volatilityTicks: '10', minLots: '1', maxLots: '5' });
  const schema = [
    { name: 'return1', source: 'mid', kind: 'return', lag: 1, unit: 'ratio' },
    { name: 'return3', source: 'mid', kind: 'return', lag: 3, unit: 'ratio' },
    { name: 'mean5', source: 'mid', kind: 'mean', window: 5, unit: 'quote-minor-per-lot' }
  ];
  const features = computeFeatures(ticks.map(t => ({ time: t.time, availableAt: t.time, values: { mid: (Number(t.bid) + Number(t.ask)) / 2 } })), schema);
  const samples = features.flatMap((feature, i) => !feature.ready || i === ticks.length - 1 ? [] : [{ id: `sample-${i}`, time: feature.time, labelAvailableAt: ticks[i + 1].time, feature, target: Number(ticks[i + 1].bid) / Number(ticks[i].bid) - 1 }]);
  const plan = walkForwardSplits(samples, { trainSize: 50, validationSize: 30, embargoMs: '2', finalStart: 110 });
  const fold = plan.folds[0], training = foldRows(samples, plan, fold.id, 'train', 'train').map(row => ({ ...row, partition: 'train' }));
  const validation = foldRows(samples, plan, fold.id, 'select', 'validation');
  const wantedTimes = new Set(validation.map(row => row.time));
  const evaluationTicks = ticks.filter(t => wantedTimes.has(t.time));
  const execution = { quantity: '10', feePerLot: '1' };
  let strategy, regression = null, model = null;
  if (kind === 'hold') strategy = buyAndHold(execution);
  else if (kind === 'crossover') strategy = movingAverageCrossover({ ...execution, fast: parameters.fast ?? 3, slow: parameters.slow ?? 10 });
  else if (kind === 'reversion') strategy = meanReversion({ ...execution, window: parameters.window ?? 5, entryBps: parameters.entryBps ?? '50' });
  else if (kind === 'ridge') {
    // Explicit fixture assumption: training/deployment take one simulated ms.
    const deployedAt = String(BigInt(fold.cutoff) + 1n);
    model = fitRidge({ rows: training, schema, fold: fold.id, cutoff: fold.cutoff, trainingStartedAt: fold.cutoff, trainingCompletedAt: deployedAt, deployedAt, alpha: parameters.alpha ?? 1 });
    const byTime = new Map(validation.map(row => [row.time, row.feature]));
    strategy = targetPosition(({ history }) => {
      const time = history.at(-1).time;
      const p = predictRidge({ model, feature: byTime.get(time), schema, fold: fold.id, decisionTime: time });
      return p.prediction > (parameters.threshold ?? 0) ? execution.quantity : '0';
    }, { feePerLot: execution.feePerLot, maxPositionLots: execution.quantity });
    regression = evaluateRegression({ model, rows: validation.map(row => ({ ...row, partition: 'validation', decisionTime: row.time })), schema, fold: fold.id, partition: 'validation' });
    context.writeArtifact('model.json', model);
    context.writeArtifact('regression.json', regression);
  } else throw new Error(`Unknown strategy kind ${kind}`);
  const config = { instrument, initialCash: '20000', feePerLot: '1', orderLatencyMs: '1', cancelLatencyMs: '2', maxQuoteAgeMs: '100', manifest: {
    datasetVersion: `synthetic-xorshift32-${datasetSeed}`, strategyArtifact: model?.hash ?? hash({ kind, parameters }), evaluationProtocol: `validation-only/${fold.hash}`, seed: String(context.seed)
  } };
  const report = runStrategy(config, evaluationTicks, strategy).report();
  context.writeArtifact('split-plan.json', plan); context.writeArtifact('report.json', report);
  return { kind, parameters, datasetHash: hash(ticks), foldHash: fold.hash, report, regressionMetrics: regression ? { mse: regression.mse, mae: regression.mae } : null };
}
