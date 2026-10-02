import { runStrategy, json } from '../src/framework.mjs';
import { syntheticQuotes } from '../src/data.mjs';
import { buyAndHold, movingAverageCrossover, meanReversion } from '../src/strategies.mjs';

// Run after npm run build: node examples/strategies.mjs
// These deterministic fixtures exercise infrastructure, not strategy performance.
const instrument = { symbol: 'SYNTH', currency: 'EUR', priceTick: '1', lotSize: '1' };
const quotes = syntheticQuotes({ instrument, count: 200, seed: '41', initialBid: '1000', spreadTicks: '2', volatilityTicks: '8', minLots: '0', maxLots: '5' });
const execution = { quantity: '10', feePerLot: '1' };
const strategies = {
  hold: buyAndHold(execution),
  trend: movingAverageCrossover({ ...execution, fast: 5, slow: 20 }),
  reversion: meanReversion({ ...execution, window: 15, entryBps: '100', exitBps: '20' }),
};
for (const [name, strategy] of Object.entries(strategies)) {
  const config = { instrument, initialCash: '20000', feePerLot: execution.feePerLot, orderLatencyMs: '1', cancelLatencyMs: '2', maxQuoteAgeMs: '100',
    manifest: { datasetVersion: 'synthetic-xorshift32-v1', strategyArtifact: `example-${name}`, evaluationProtocol: 'fixture-only-no-performance-claim', seed: '41' } };
  const report = runStrategy(config, quotes, strategy).report();
  console.log(json({ strategy: name, fills: report.fills.length, ledger: report.ledger, performance: report.performance }));
}
