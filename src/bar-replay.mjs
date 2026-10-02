import { requireThat } from './core.mjs';
import { runStrategy } from './replay.mjs';
export { validateBars } from './bars.mjs';

// onBar is a signal interface; all execution assumptions live on the venue.
export function runBarStrategy(informationSource, executionVenue, strategy, options = {}) {
  requireThat(Object.keys(options).every(key => key === 'historyLimit'), 'BAR_OPTION', 'Bar runner options contain only historyLimit; configure execution on the venue');
  const { historyLimit = strategy?.lookback ?? 256 } = options;
  requireThat(strategy && typeof strategy.onBar === 'function', 'BAR_STRATEGY', 'Expected a strategy with onBar(context)');
  requireThat(Number.isSafeInteger(historyLimit) && historyLimit > 0 && historyLimit >= (strategy.lookback ?? 1), 'BAR_HISTORY', 'historyLimit must cover the strategy lookback');
  const replay = runStrategy(informationSource, executionVenue, context => {
    const target = strategy.onBar(Object.freeze({ ...context, bar: context.observation }));
    requireThat(target === null || typeof target === 'string', 'BAR_STRATEGY_OUTPUT', 'onBar must return canonical target lots or explicit null');
    return target;
  }, { lookback: historyLimit });
  const diagnostics = structuredClone(strategy.diagnostics?.() ?? null);
  return Object.freeze({ ...replay, report() {
    const report = replay.report();
    return { ...report, barReplay: { ...report.barReplay,
      inputBarsHash: informationSource.manifest.datasetHash, count: replay.observationCount,
      startTime: replay.firstObservation?.openTime ?? null, endTime: replay.endTime,
      targetsHash: replay.targetsHash, strategyDiagnostics: structuredClone(diagnostics) } };
  } });
}
