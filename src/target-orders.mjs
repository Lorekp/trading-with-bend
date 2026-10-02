import { nat, requireThat } from './core.mjs';
import { affordableLots, cappedLots } from './policies.mjs';
const windowSize = (value, name) => requireThat(Number.isSafeInteger(value) && value > 0, 'STRATEGY_PARAMETER', `${name} must be a positive integer`);
const stateNat = (value, name) => nat(typeof value === 'bigint' ? String(value) : value, name);
const sum = values => values.reduce((total, value) => total + value, 0n);

// A stateless execution adapter suitable for rules or model-generated targets.
// Reuse with multiple runs is safe. A decision is based only on its supplied
// venue quote prefix; external information captured by a user callback is not sandboxed.
export function targetOrders(target, { feePerLot, maxPositionLots, warmup = 1 } = {}) {
  nat(feePerLot, 'feePerLot'); nat(maxPositionLots, 'maxPositionLots'); windowSize(warmup, 'warmup');
  requireThat(typeof target === 'function' || typeof target === 'string', 'STRATEGY_PARAMETER', 'target must be a canonical lot string or callback returning one');
  if (typeof target === 'string') nat(target, 'target');
  const fee = BigInt(feePerLot), cap = BigInt(maxPositionLots);
  return context => {
    requireThat(context && Array.isArray(context.history) && Array.isArray(context.orders), 'STRATEGY_CONTEXT', 'Expected history, ledger and orders from the execution venue');
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
}
