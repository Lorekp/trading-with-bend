import { Backtest } from './framework.mjs';
import { nat, checked, requireThat, hash } from './core.mjs';
import { barExecutionAllowed, cappedLots } from './policies.mjs';
import { targetPosition } from './strategies.mjs';

const fields = ['openTime', 'closeTime', 'availableAt', 'open', 'high', 'low', 'close', 'volumeLots'];
const positive = value => nat(value, 'positive bar value', true);
const ceilDiv = (value, denominator) => (value + denominator - 1n) / denominator;
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function spread(price, bps, tick) {
  const bid = price * (10000n - bps) / (10000n * tick) * tick;
  const ask = ceilDiv(price * (10000n + bps), 10000n * tick) * tick;
  requireThat(bid > 0n, 'BAR_PRICE_RANGE', 'Spread rounds bid to zero');
  return { bid: String(checked(bid, 'modeled bid')), ask: String(checked(ask, 'modeled ask')) };
}

/** Validate complete, fixed-width, gap-free bars before processing any orders. */
export function validateBars(input, instrument) {
  requireThat(Array.isArray(input) && input.length >= 2, 'BAR_DATA', 'At least two completed bars are required');
  const tick = positive(instrument.priceTick);
  let previous = null, interval = null;
  return Object.freeze(input.map((bar, index) => {
    requireThat(bar && typeof bar === 'object' && !Array.isArray(bar) && Object.getPrototypeOf(bar) === Object.prototype && Reflect.ownKeys(bar).length === fields.length && fields.every(key => Object.hasOwn(bar, key)) && Object.values(Object.getOwnPropertyDescriptors(bar)).every(descriptor => descriptor.enumerable && Object.hasOwn(descriptor, 'value')), 'BAR_SCHEMA', `Bar ${index}: require plain data objects with exactly the supported fields`);
    const v = Object.fromEntries(fields.map(key => [key, nat(bar[key], `bar[${index}].${key}`, ['open', 'high', 'low', 'close'].includes(key))]));
    requireThat(v.closeTime >= v.openTime && v.availableAt === v.closeTime + 1n, 'BAR_TIME', 'Bars become available only after their inclusive close timestamp');
    const width = v.availableAt - v.openTime;
    requireThat(width > 1n && (interval === null || interval === width), 'BAR_INTERVAL', 'Bar intervals must be equal and exceed one millisecond');
    requireThat(previous === null || previous === v.openTime, 'BAR_GAP', 'Bars must be contiguous, unique and increasing; gaps must be resolved explicitly');
    requireThat(v.low <= v.open && v.low <= v.close && v.high >= v.open && v.high >= v.close && v.low <= v.high, 'BAR_OHLC', 'OHLC extrema do not contain open/close');
    for (const key of ['open', 'high', 'low', 'close']) requireThat(v[key] % tick === 0n, 'PRICE_TICK', `Bar ${key} is off tick`);
    interval = width; previous = v.availableAt;
    return freeze(Object.fromEntries(fields.map(key => [key, String(v[key])])));
  }));
}

/**
 * Explicit price-proxy scenario, not an exchange quote or perpetual simulator.
 * A completed bar may decide at availableAt. An artificial execution opportunity
 * occurs at next open + delay, priced at that open plus/minus an assumed spread.
 * Only the previous, already completed bar supplies the participation budget.
 */
export function runBarStrategy(config, input, strategy, options = {}) {
  const { maxPositionLots, halfSpreadBps = '2', participationBps = '10', maxLiquidityLots = '10000',
    limitBufferBps = '100', executionDelayMs = '1', historyLimit = strategy?.lookback ?? 256,
    traceMode = 'compact', orderStorage = 'active' } = options;
  requireThat(Object.keys(options).every(key => ['maxPositionLots', 'halfSpreadBps', 'participationBps', 'maxLiquidityLots', 'limitBufferBps', 'executionDelayMs', 'historyLimit', 'traceMode', 'orderStorage'].includes(key)), 'BAR_OPTION', 'Unknown bar replay option');
  requireThat(strategy && typeof strategy.onBar === 'function', 'BAR_STRATEGY', 'Expected a strategy with onBar(context)');
  requireThat(Number.isSafeInteger(historyLimit) && historyLimit > 0 && historyLimit >= (strategy.lookback ?? 1), 'BAR_HISTORY', 'historyLimit must cover the strategy lookback');
  nat(maxPositionLots, 'maxPositionLots'); nat(maxLiquidityLots, 'maxLiquidityLots');
  const half = nat(halfSpreadBps, 'halfSpreadBps'), participation = nat(participationBps, 'participationBps'), collar = nat(limitBufferBps, 'limitBufferBps');
  requireThat(half < 10000n && participation <= 10000n && collar < 10000n, 'BAR_OPTION', 'Require spread/collar <10000 bps and participation <=10000 bps');
  const delay = nat(executionDelayMs, 'executionDelayMs', true), tickSize = positive(config.instrument.priceTick);
  const bars = validateBars(input, config.instrument), duration = BigInt(bars[0].availableAt) - BigInt(bars[0].openTime);
  requireThat(delay < duration, 'BAR_TIMING', 'Execution delay must fit within the following bar');
  requireThat(BigInt(config.orderLatencyMs) <= delay, 'BAR_TIMING', 'Order latency cannot exceed the modeled next-open execution delay');
  const backtest = new Backtest(config, { traceMode, orderStorage }), evidence = [], targets = [];
  config = backtest.config;
  let sequence = 0n, orderId = 0n, desired = '0';
  const reconcile = targetPosition(() => desired, { maxPositionLots });
  const base = (id, time) => ({ id, time: String(time), sequence: String(++sequence), symbol: config.instrument.symbol, currency: config.instrument.currency });
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index], previous = bars[index - 1], executionTime = checked(BigInt(bar.openTime) + delay, 'bar execution time');
    const opening = spread(BigInt(bar.open), half, tickSize);
    const budget = previous ? BigInt(previous.volumeLots) * participation / 10000n : 0n;
    // Multiplication is host BigInt; only the final bounded natural enters Bend.
    const liquidity = cappedLots(String(checked(budget, 'participation budget')), maxLiquidityLots, maxLiquidityLots);
    if (previous) requireThat(barExecutionAllowed({ availableAt: previous.availableAt, openTime: bar.openTime, executionTime: String(executionTime) }), 'BAR_CAUSALITY', 'Modeled execution must follow bar availability and next open');
    const openEvent = { ...base(`bar-open-${index}`, executionTime), type: 'tick', sourceTime: String(executionTime), ...opening, bidLots: liquidity, askLots: liquidity };
    backtest.step(openEvent);
    evidence.push(freeze({ eventId: openEvent.id, executionTime: String(executionTime), openTime: bar.openTime,
      sourceOpen: bar.open, priorAvailableAt: previous?.availableAt ?? null, priorVolumeLots: previous?.volumeLots ?? '0', ...opening, budgetPerSide: liquidity }));
    const closing = spread(BigInt(bar.close), half, tickSize);
    const closeEvent = { ...base(`bar-close-${index}`, bar.availableAt), type: 'tick', sourceTime: bar.availableAt, ...closing, bidLots: '0', askLots: '0' };
    backtest.step(closeEvent);
    const currentOrders = backtest.workingOrders;
    const context = freeze({ bar, history: bars.slice(Math.max(0, index + 1 - historyLimit), index + 1), ledger: backtest.ledger, orders: currentOrders, index, tickCount: index + 1 });
    const target = strategy.onBar(context);
    requireThat(target === null || typeof target === 'string', 'BAR_STRATEGY_OUTPUT', 'onBar must return canonical target lots or explicit null');
    if (target !== null) { nat(target, 'strategy target'); desired = target; }
    targets.push({ time: bar.availableAt, target });
    // The final mark accounts for open inventory. Do not create unfillable final
    // decisions, infer an intrabar stop ordering, or invent an exit transaction.
    if (index === bars.length - 1 || target === null) continue;
    const limitQuote = { ...closeEvent, ...spread(BigInt(bar.close), collar, tickSize) };
    const decisions = reconcile({ config, history: [limitQuote], ledger: backtest.ledger, orders: currentOrders });
    for (const decision of decisions) {
      const event = { ...decision, ...base(`bar-decision-${++orderId}`, bar.availableAt) };
      if (decision.type === 'submit') event.orderId = String(orderId);
      backtest.step(event);
    }
  }
  const assumptions = freeze({ model: 'completed-bar-next-open-cash-price-proxy-v1', sourceMarket: 'USD-M perpetual futures price series',
    account: 'Cash-only long/flat spot-style proxy; no perpetual contract, funding, leverage, liquidation or exchange fee schedule',
    execution: 'Hypothetical bid/ask at next bar open plus delay; open price held fixed for that delay; not observed executable quotes',
    timing: 'Decide at inclusive closeTime+1; next-open execution strictly after availability and open; decisions at final bar are not submitted',
    liquidity: 'Each side receives min(maxLiquidityLots, floor(previous completed bar volumeLots * participationBps / 10000)); no current/future bar volume',
    limits: 'Decision-close price collar; gaps outside the collar may not fill. Pending orders reconcile through cancellations and can miss an opening opportunity',
    stops: 'Only completed-bar signals; no assumed intrabar high/low ordering',
    costs: 'Half spread on each side plus fixed micro-quote units per filled lot from engine config; scenario inputs, not calibrated venue costs',
    halfSpreadBps, participationBps, maxLiquidityLots, limitBufferBps, executionDelayMs, maxPositionLots, historyLimit,
    orderStorage, callbackOrders: 'Working orders only; all orders remain in the engine report/checkpoint' });
  freeze(evidence);
  const diagnostics = freeze(structuredClone(strategy.diagnostics?.() ?? null)), inputBarsHash = hash(bars), targetsHash = hash(targets), terminalSequence = backtest.lastSequence;
  return Object.freeze({ backtest, report() {
    requireThat(backtest.lastSequence === terminalSequence, 'BAR_REPLAY_CHANGED', 'Bar reports describe a completed replay; use the underlying engine report for appended events');
    const report = backtest.report();
    return { ...report, barReplay: { inputBarsHash, count: bars.length, startTime: bars[0].openTime, endTime: bars.at(-1).availableAt,
      assumptions, executionInputs: evidence, targetsHash, strategyDiagnostics: diagnostics } };
  } });
}
