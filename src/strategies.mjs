import { integer, nat, requireThat } from './core.mjs';
import { cappedLots } from './policies.mjs';

const windowSize = (value, name) => requireThat(Number.isSafeInteger(value) && value > 0, 'STRATEGY_PARAMETER', `${name} must be a positive integer`);
const stateNat = (value, name) => nat(typeof value === 'bigint' ? String(value) : value, name);
const mid2 = tick => nat(tick.bid, 'bid', true) + nat(tick.ask, 'ask', true);
const sum = values => values.reduce((total, value) => total + value, 0n);

// Strategies emit intent only. Venue adapters own sizing feasibility and orders.
export function targetPosition(target, options = {}) {
  requireThat(Object.keys(options).every(key => ['maxPositionLots', 'warmup'].includes(key)), 'STRATEGY_PARAMETER', 'Signal options are maxPositionLots and warmup; execution costs belong to the venue');
  const { maxPositionLots, warmup = 1 } = options;
  windowSize(warmup, 'warmup');
  if (maxPositionLots !== undefined) nat(maxPositionLots, 'maxPositionLots');
  requireThat(typeof target === 'function' || typeof target === 'string', 'STRATEGY_PARAMETER', 'target must be a canonical lot string or callback');
  if (typeof target === 'string') integer(target, 'target');
  const onTick = context => {
    requireThat(Array.isArray(context?.history), 'STRATEGY_CONTEXT', 'Expected information history');
    if (context.history.length < warmup) return null;
    const requested = typeof target === 'function' ? target(context) : target;
    if (requested === null) return null;
    const signed = integer(requested, 'target');
    if (maxPositionLots === undefined) return requested;
    const magnitude = cappedLots(String(signed < 0n ? -signed : signed), maxPositionLots, maxPositionLots);
    return signed < 0n && magnitude !== '0' ? `-${magnitude}` : magnitude;
  };
  return Object.freeze(Object.assign(onTick, { lookback: warmup }));
}

export function buyAndHold({ quantity, maxPositionLots = quantity, ...options } = {}) {
  nat(quantity, 'quantity', true);
  return targetPosition(quantity, { ...options, maxPositionLots });
}

// Inclusive moving averages use only quotes visible at this decision. The
// comparison cross-multiplies exact midpoint sums, avoiding floating point ties.
export function movingAverageCrossover({ fast = 5, slow = 20, quantity, maxPositionLots = quantity, warmup = slow, ...options } = {}) {
  windowSize(fast, 'fast'); windowSize(slow, 'slow'); windowSize(warmup, 'warmup'); nat(quantity, 'quantity', true);
  requireThat(fast < slow, 'STRATEGY_PARAMETER', 'fast must be smaller than slow');
  return targetPosition(({ history }) => {
    const recent = history.slice(-slow).map(mid2);
    return sum(recent.slice(-fast)) * BigInt(slow) > sum(recent) * BigInt(fast) ? quantity : '0';
  }, { ...options, maxPositionLots, warmup: Math.max(warmup, slow) });
}

// The reference mean excludes the current quote. Enter below entryBps and exit
// when the quote recovers to within exitBps of that mean. Hysteresis is derived
// from actual holdings / pending buys instead of mutable strategy instance state.
export function meanReversion({ window = 20, entryBps = '100', exitBps = '0', quantity, maxPositionLots = quantity, warmup = window + 1, ...options } = {}) {
  windowSize(window, 'window'); windowSize(warmup, 'warmup'); nat(quantity, 'quantity', true);
  const enter = nat(entryBps, 'entryBps', true), exit = nat(exitBps, 'exitBps');
  requireThat(exit < enter && enter < 10000n, 'STRATEGY_PARAMETER', 'Require 0 <= exitBps < entryBps < 10000');
  return targetPosition(({ history, ledger, orders }) => {
    const reference = sum(history.slice(-window - 1, -1).map(mid2));
    const current = mid2(history.at(-1)) * BigInt(window) * 10000n;
    const exposed = stateNat(ledger.quantity, 'ledger.quantity') > 0n || orders.some(order => order.side === 'buy' && stateNat(order.remaining, 'order.remaining') > 0n);
    if (exposed) return current < reference * (10000n - exit) ? quantity : '0';
    return current <= reference * (10000n - enter) ? quantity : '0';
  }, { ...options, maxPositionLots, warmup: Math.max(warmup, window + 1) });
}
