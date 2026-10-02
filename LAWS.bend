import Base
import ./bend/Engine.bend as E
import ./bend/Policy.bend as P

# Specifications: review changes independently from implementation and proofs.
# Preconditions are explicit; Nat.sub itself is saturating, not checked.
law buy_updates_ledger_exactly:
  for spare: Nat
  for quantity: Nat
  for price: Nat
  for lots: Nat
  for fee: Nat
  {E.buy(Nat.add(E.cost(price, lots, fee), spare), quantity, price, lots, fee)
   == E.Ledger{spare, Nat.add(quantity, lots)} : E.Ledger}

law sell_updates_ledger_exactly:
  for cash: Nat
  for spare: Nat
  for net_price: Nat
  for lots: Nat
  for fee: Nat
  {E.sell(cash, Nat.add(lots, spare), Nat.add(fee, net_price), lots, fee)
   == E.Ledger{Nat.add(cash, Nat.mul(lots, net_price)), spare} : E.Ledger}

law cancellation_is_idempotent:
  for order: E.Order
  {E.cancel(E.cancel(order)) == E.cancel(order) : E.Order}

law cancellation_clears_working_quantity:
  for id: Nat
  for side: E.Side
  for price: Nat
  for accepted: Nat
  for working: Nat
  for filled: Nat
  for cancelled: Nat
  for decision: Nat
  for arrival: Nat
  for cancel_at: Maybe<&2, Nat>
  {E.cancel(E.Order{id, side, price, accepted, working, filled, cancelled, decision, arrival, cancel_at})
   == E.Order{id, side, price, accepted, 0n, filled, Nat.add(working, cancelled), decision, arrival, None{}} : E.Order}

law accepted_submission_preserves_holdings:
  for ledger: E.Ledger
  for orders: List<&2, E.Order>
  for order: E.Order
  {E.admit_if(True{}, E.State{ledger, orders}, order)
   == E.Accepted{E.State{ledger, E.append(orders, order)}} : E.Admission}

law rejected_submission_preserves_state:
  for state: E.State
  for order: E.Order
  {E.admit_if(False{}, state, order) == E.Rejected{state} : E.Admission}

law liquidity_is_bounded:
  for requested: Nat
  for available: Nat
  {Nat.is_le(Nat.min(requested, available), available) == True{} : Bool}

law liquidity_partition_is_exact:
  for requested: Nat
  for available: Nat
  {Nat.add(Nat.min(requested, available), Nat.sub(available, Nat.min(requested, available))) == available : Nat}

law partial_fill_updates_order_exactly:
  for id: Nat
  for side: E.Side
  for price: Nat
  for accepted: Nat
  for spare: Nat
  for lots: Nat
  for filled: Nat
  for cancelled: Nat
  for decision: Nat
  for arrival: Nat
  for cancel_at: Maybe<&2, Nat>
  {E.fill_order(E.Order{id, side, price, accepted, Nat.add(lots, spare), filled, cancelled, decision, arrival, cancel_at}, lots)
   == E.Order{id, side, price, accepted, spare, Nat.add(filled, lots), cancelled, decision, arrival, cancel_at} : E.Order}

law clock_replay_composes:
  for first: List<&2, Nat>
  for second: List<&2, Nat>
  for state: E.State
  {E.replay(List.append(&2, Nat, first, second), state)
   == E.replay(second, E.replay(first, state)) : E.State}

# Research policy laws are independent of strategy/model numerical algorithms.
law selection_cannot_read_final:
  {P.can_read(P.Select{}, P.Holdout{}) == False{} : Bool}

law training_cannot_read_final:
  {P.can_read(P.Train{}, P.Holdout{}) == False{} : Bool}

law training_cannot_read_validation:
  {P.can_read(P.Train{}, P.Validation{}) == False{} : Bool}

law final_role_can_read_final:
  {P.can_read(P.Final{}, P.Holdout{}) == True{} : Bool}

law capped_lots_respects_all_limits:
  for requested: Nat
  for capital: Nat
  for position: Nat
  result = P.capped_lots(requested, capital, position)
  {Bool.and(Nat.is_le(result, requested), Bool.and(Nat.is_le(result, capital), Nat.is_le(result, position))) == True{} : Bool}

law capped_lots_fills_feasible_request:
  for requested: Nat
  for cash_spare: Nat
  for position_spare: Nat
  {P.capped_lots(requested, Nat.add(requested, cash_spare), Nat.add(requested, position_spare)) == requested : Nat}

law unavailable_labels_are_excluded:
  for observed: Nat
  for +cutoff: Nat
  for delay: Nat
  {P.training_allowed(observed, Nat.add(cutoff, delay), cutoff) == False{} : Bool}

law future_observations_are_excluded:
  for cutoff: Nat
  for delay: Nat
  for mature: Nat
  {P.training_allowed(Nat.add(cutoff, delay), mature, cutoff) == False{} : Bool}
