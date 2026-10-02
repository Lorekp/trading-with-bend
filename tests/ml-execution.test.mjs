import { replayQuotes as runStrategy } from './replay-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures } from '../src/features.mjs';
import { fitRidge, predictRidge } from '../src/models.mjs';
import { targetPosition } from '../src/strategies.mjs';

test('a trained model target produces causal executable fills through the shared ledger', () => {
  const schema = [{ name: 'price', source: 'price', kind: 'value', unit: 'quote-minor-per-lot' }];
  const features = computeFeatures([10, 11, 12].map((price, i) => ({ time: String(i), availableAt: String(i), values: { price } })), schema);
  const rows = features.map((feature, i) => ({ id: `train-${i}`, partition: 'train', feature, target: 0.01, labelAvailableAt: String(i + 1) }));
  const model = fitRidge({ rows, schema, fold: 'train-before-five', cutoff: '4', trainingStartedAt: '4', trainingCompletedAt: '5', deployedAt: '5', alpha: 1 });
  const instrument = { symbol: 'ML', currency: 'EUR', priceTick: '1', lotSize: '1' };
  const ticks = [5, 6].map(time => ({ id: `tick-${time}`, type: 'tick', time: String(time), sourceTime: String(time), sequence: String(time), symbol: 'ML', currency: 'EUR', bid: '99', ask: '100', bidLots: '10', askLots: '10' }));
  const observed = computeFeatures(ticks.map(tick => ({ time: tick.time, availableAt: tick.time, values: { price: 100 } })), schema);
  const strategy = targetPosition(({ history }) => {
    const time = history.at(-1).time, feature = observed.find(row => row.time === time);
    const prediction = predictRidge({ model, feature, schema, fold: model.fold, decisionTime: time });
    return prediction.prediction > 0 ? '2' : '0';
  }, { maxPositionLots: '2' });
  const config = { instrument, initialCash: '1000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '10', manifest: { datasetVersion: 'analytic-ml-execution', strategyArtifact: model.hash, evaluationProtocol: 'independent-test', seed: 'none' } };
  const report = runStrategy(config, ticks, strategy).report();
  assert.equal(report.fills.length, 1); assert.equal(report.fills[0].decisionTime, '5'); assert.equal(report.fills[0].executionTime, '6');
  assert.equal(report.ledger.cash, '798'); assert.equal(report.ledger.quantity, '2');
  assert.equal(report.performance.fees, '2'); assert.equal(report.performance.netPnl, '-4');
});
