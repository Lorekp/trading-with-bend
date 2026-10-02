import { MAX_NAT } from '../src/core.mjs';
import { runStrategy } from '../src/replay.mjs';
import { runBarStrategy } from '../src/bar-replay.mjs';
import { quoteInformationSource, barInformationSource } from '../src/information-source.mjs';
import { QuoteExecutionVenue } from '../src/execution-venue.mjs';
import { BarExecutionVenue } from '../src/bar-execution-venue.mjs';

// Existing single-market regressions intentionally wire identical fixture data
// to both independently constructed adapters. Cross-market cases wire separately.
export function replayQuotes(config, ticks, strategy, { lookback, ...execution } = {}) {
  const source = quoteInformationSource({ id: 'fixture-information', instrument: config.instrument, ticks });
  const venue = new QuoteExecutionVenue({ id: 'fixture-execution', config, ticks, maxPositionLots: String(MAX_NAT), ...execution });
  runStrategy(source, venue, strategy, { lookback });
  return venue.backtest;
}

export function replayBars(config, bars, strategy, { historyLimit, ...execution } = {}) {
  const source = barInformationSource({ id: 'fixture-information', instrument: config.instrument, bars });
  const venue = new BarExecutionVenue({ id: 'fixture-price-proxy', config, bars, ...execution });
  const replay = runBarStrategy(source, venue, strategy, { historyLimit });
  return { ...replay, backtest: venue.backtest };
}
