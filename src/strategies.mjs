import { nat, requireThat } from './core.mjs';
import { affordableLots, cappedLots } from './policies.mjs';

const windowSize = (value, name) => requireThat(Number.isSafeInteger(value) && value > 0, 'STRATEGY_PARAMETER', `${name} must be a positive integer`);
const stateNat = (value, name) => nat(typeof value === 'bigint' ? String(value) : value, name);
const mid2 = tick => nat(tick.bid, 'bid', true) + nat(tick.ask, 'ask', true);
const sum = values => values.reduce((total, value) => total + value, 0n);

// A stateless execution adapter suitable for rules or model-generated targets.
// Reuse with multiple runs is safe. A decision is based only on its supplied
// history prefix; external information captured by a user callback is not sandboxed.
export function targetPosition(target, { maxPositionLots, warmup = 1, ...unknown } = {}) {
  requireThat(Object.keys(unknown).length === 0, 'STRATEGY_PARAMETER', 'Only maxPositionLots and warmup are strategy execution options; fees come from the replay config');
  nat(maxPositionLots, 'maxPositionLots'); windowSize(warmup, 'warmup');
  requireThat(typeof target === 'function' || typeof target === 'string', 'STRATEGY_PARAMETER', 'target must be a canonical lot string or callback returning one');
  if (typeof target === 'string') nat(target, 'target');
  const cap = BigInt(maxPositionLots);
  const onTick = context => {
    requireThat(context && Array.isArray(context.history) && Array.isArray(context.orders), 'STRATEGY_CONTEXT', 'Expected history, ledger and orders from runStrategy');
    const feePerLot = context.config?.feePerLot, fee = nat(feePerLot, 'config.feePerLot');
    if (context.history.length < warmup) return [];
    const requested = typeof target === 'function' ? target(context) : target;
    if (requested === null || requested === undefined) return [];
    nat(requested, 'target');
    const desired = BigInt(cappedLots(requested, maxPositionLots, maxPositionLots));
    const cash = stateNat(context.ledger.cash, 'ledger.cash'), position = stateNat(context.ledger.quantity, 'ledger.quantity');
    const quote = context.history.at(-1), bid = nat(quote.bid, 'bid', true), ask = nat(quote.ask, 'ask', true);
    const delta = desired - position, side = delta > 0n ? 'buy' : 'sell', distance = delta < 0n ? -delta : delta;
    const active = context.orders.filter(order => stateNat(order.remaining, 'order.remaining') > 0n);
    if (active.length) {
      // Never stack exposure, including while cancellation is in flight. A fill
      // can still occur before a delayed cancellation reaches the exchange.
      if (active.some(order => order.cancel_at?.$ === 'Some')) {
        return active.filter(order => order.cancel_at?.$ !== 'Some').map(order => ({ type: 'cancel', orderId: String(stateNat(order.id, 'order.id')) }));
      }
      const total = sum(active.map(order => stateNat(order.remaining, 'order.remaining')));
      const stale = delta === 0n || total > distance || active.some(order => {
        const orderSide = order.side?.$ === 'Buy' ? 'buy' : order.side?.$ === 'Sell' ? 'sell' : null;
        requireThat(orderSide !== null, 'STRATEGY_CONTEXT', 'Unknown order side');
        const limit = stateNat(order.limit, 'order.limit');
        return orderSide !== side || (side === 'buy' ? limit < ask : limit > bid);
      });
      return stale ? active.map(order => ({ type: 'cancel', orderId: String(stateNat(order.id, 'order.id')) })) : [];
    }
    if (delta === 0n) return [];
    const limit = side === 'buy' ? ask : bid;
    if (side === 'sell' && limit < fee) return [];
    const budget = side === 'buy' ? affordableLots(String(cash), '0', String(limit), feePerLot) : String(position);
    const headroom = side === 'buy' ? (position < cap ? cap - position : 0n) : position;
    const quantity = cappedLots(String(distance), budget, String(headroom));
    return quantity === '0' ? [] : [{ type: 'submit', side, limit: String(limit), quantity }];
  };
  return Object.freeze(Object.assign(onTick, { lookback: warmup }));
}

export function buyAndHold({ quantity, maxPositionLots = quantity, ...execution } = {}) {
  nat(quantity, 'quantity', true);
  return targetPosition(quantity, { ...execution, maxPositionLots });
}

// Inclusive moving averages use only quotes visible at this decision. The
// comparison cross-multiplies exact midpoint sums, avoiding floating point ties.
export function movingAverageCrossover({ fast = 5, slow = 20, quantity, maxPositionLots = quantity, warmup = slow, ...execution } = {}) {
  windowSize(fast, 'fast'); windowSize(slow, 'slow'); windowSize(warmup, 'warmup'); nat(quantity, 'quantity', true);
  requireThat(fast < slow, 'STRATEGY_PARAMETER', 'fast must be smaller than slow');
  return targetPosition(({ history }) => {
    const recent = history.slice(-slow).map(mid2);
    return sum(recent.slice(-fast)) * BigInt(slow) > sum(recent) * BigInt(fast) ? quantity : '0';
  }, { ...execution, maxPositionLots, warmup: Math.max(warmup, slow) });
}

// The reference mean excludes the current quote. Enter below entryBps and exit
// when the quote recovers to within exitBps of that mean. Hysteresis is derived
// from actual holdings / pending buys instead of mutable strategy instance state.
export function meanReversion({ window = 20, entryBps = '100', exitBps = '0', quantity, maxPositionLots = quantity, warmup = window + 1, ...execution } = {}) {
  windowSize(window, 'window'); windowSize(warmup, 'warmup'); nat(quantity, 'quantity', true);
  const enter = nat(entryBps, 'entryBps', true), exit = nat(exitBps, 'exitBps');
  requireThat(exit < enter && enter < 10000n, 'STRATEGY_PARAMETER', 'Require 0 <= exitBps < entryBps < 10000');
  return targetPosition(({ history, ledger, orders }) => {
    const reference = sum(history.slice(-window - 1, -1).map(mid2));
    const current = mid2(history.at(-1)) * BigInt(window) * 10000n;
    const exposed = stateNat(ledger.quantity, 'ledger.quantity') > 0n || orders.some(order => order.side?.$ === 'Buy' && stateNat(order.remaining, 'order.remaining') > 0n);
    if (exposed) return current < reference * (10000n - exit) ? quantity : '0';
    return current <= reference * (10000n - enter) ? quantity : '0';
  }, { ...execution, maxPositionLots, warmup: Math.max(warmup, window + 1) });
}
