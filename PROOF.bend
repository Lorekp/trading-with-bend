import Base
import ./LAWS.bend as Laws
import ./bend/Engine.bend as E
import ./bend/Policy.bend as P

def Laws.derivative_posting_is_exact(credits, debits, credit, debit):
  {==}

def derivative_add_zero(a: Nat) -> {Nat.add(a, 0n) == a : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %derivative_add_zero(p) : {1n+Nat.add(p, 0n) == 1n+_ : Nat}
      {==}

def Laws.derivative_zero_posting_preserves_cash(credits, debits):
  %derivative_add_zero(credits) :
    {E.DerivativeCash{Nat.add(credits, 0n), Nat.add(debits, 0n)} == E.DerivativeCash{_, debits} : E.DerivativeCash}
  %derivative_add_zero(debits) :
    {E.DerivativeCash{Nat.add(credits, 0n), Nat.add(debits, 0n)} == E.DerivativeCash{Nat.add(credits, 0n), _} : E.DerivativeCash}
  {==}

law subtract_added:
  for amount: Nat
  for spare: Nat
  {Nat.sub(Nat.add(amount, spare), amount) == spare : Nat}

def subtract_added(amount, spare):
  match amount:
    case 0n:
      match spare:
        case 0n:
          {==}
        case 1n+p:
          {==}
    case 1n+p:
      subtract_added(p, spare)

def Laws.buy_updates_ledger_exactly(spare, quantity, price, lots, fee):
  %subtract_added(Nat.mul(lots, Nat.add(price, fee)), spare) :
    {E.Ledger{Nat.sub(Nat.add(Nat.mul(lots, Nat.add(price, fee)), spare), Nat.mul(lots, Nat.add(price, fee))), Nat.add(quantity, lots)}
     == E.Ledger{_, Nat.add(quantity, lots)} : E.Ledger}
  {==}

def Laws.sell_updates_ledger_exactly(cash, spare, net_price, lots, fee):
  %subtract_added(lots, spare) :
    {E.Ledger{Nat.add(cash, Nat.mul(lots, Nat.sub(Nat.add(fee, net_price), fee))), Nat.sub(Nat.add(lots, spare), lots)}
     == E.Ledger{Nat.add(cash, Nat.mul(lots, net_price)), _} : E.Ledger}
  %subtract_added(fee, net_price) :
    {E.Ledger{Nat.add(cash, Nat.mul(lots, Nat.sub(Nat.add(fee, net_price), fee))), Nat.sub(Nat.add(lots, spare), lots)}
     == E.Ledger{Nat.add(cash, Nat.mul(lots, _)), Nat.sub(Nat.add(lots, spare), lots)} : E.Ledger}
  {==}

def Laws.cancellation_is_idempotent(order):
  match order:
    case E.Order{id, side, price, accepted, working, filled, cancelled, decision, arrival, cancel_at}:
      {==}

def Laws.cancellation_clears_working_quantity(id, side, price, accepted, working, filled, cancelled, decision, arrival, cancel_at):
  {==}

def Laws.accepted_submission_preserves_holdings(ledger, orders, order):
  {==}

def Laws.rejected_submission_preserves_state(state, order):
  {==}

def Laws.liquidity_is_bounded(requested, available):
  match requested available:
    case 0n 0n:
      {==}
    case 0n 1n+p:
      {==}
    case 1n+r 0n:
      {==}
    case 1n+r 1n+a:
      Laws.liquidity_is_bounded(r, a)

def Laws.clock_replay_composes(first, second, state):
  match first:
    case Nil{}:
      {==}
    case Con{head, tail}:
      Laws.clock_replay_composes(tail, second, E.advance(state, head))

def Laws.liquidity_partition_is_exact(requested, available):
  match requested available:
    case 0n 0n:
      {==}
    case 0n 1n+p:
      {==}
    case 1n+r 0n:
      {==}
    case 1n+r 1n+a:
      %Laws.liquidity_partition_is_exact(r, a) :
        {1n+Nat.add(Nat.min(r, a), Nat.sub(a, Nat.min(r, a))) == 1n+_ : Nat}
      {==}

def Laws.partial_fill_updates_order_exactly(id, side, price, accepted, spare, lots, filled, cancelled, decision, arrival, cancel_at):
  %subtract_added(lots, spare) :
    {E.Order{id, side, price, accepted, Nat.sub(Nat.add(lots, spare), lots), Nat.add(filled, lots), cancelled, decision, arrival, cancel_at}
     == E.Order{id, side, price, accepted, _, Nat.add(filled, lots), cancelled, decision, arrival, cancel_at} : E.Order}
  {==}

def Laws.selection_cannot_read_final():
  {==}

def Laws.training_cannot_read_final():
  {==}

def Laws.training_cannot_read_validation():
  {==}

def Laws.final_role_can_read_final():
  {==}

def Laws.capped_lots_respects_all_limits(requested, capital, position):
  match requested capital position:
    case 0n 0n 0n:
      {==}
    case 0n 0n 1n+p:
      {==}
    case 0n 1n+c 0n:
      {==}
    case 0n 1n+c 1n+p:
      {==}
    case 1n+r 0n 0n:
      {==}
    case 1n+r 0n 1n+p:
      {==}
    case 1n+r 1n+c 0n:
      {==}
    case 1n+r 1n+c 1n+p:
      Laws.capped_lots_respects_all_limits(r, c, p)

def Laws.capped_lots_fills_feasible_request(requested, cash_spare, position_spare):
  match requested:
    case 0n:
      {==}
    case 1n+r:
      %Laws.capped_lots_fills_feasible_request(r, cash_spare, position_spare) :
        {1n+P.capped_lots(r, Nat.add(r, cash_spare), Nat.add(r, position_spare)) == 1n+_ : Nat}
      {==}

law at_or_after_not_lt:
  for cutoff: Nat
  for delay: Nat
  {Nat.is_lt(Nat.add(cutoff, delay), cutoff) == False{} : Bool}

def at_or_after_not_lt(cutoff, delay):
  match cutoff:
    case 0n:
      match delay:
        case 0n:
          {==}
        case 1n+p:
          {==}
    case 1n+c:
      at_or_after_not_lt(c, delay)

law and_false:
  for value: Bool
  {Bool.and(value, False{}) == False{} : Bool}

def and_false(value):
  match value:
    case True{}:
      {==}
    case False{}:
      {==}

def Laws.unavailable_labels_are_excluded(observed, cutoff, delay):
  %Equal.sym(Bool, Nat.is_lt(Nat.add(cutoff, delay), cutoff), False{}, at_or_after_not_lt(cutoff, delay)) :
    {Bool.and(Nat.is_lt(observed, cutoff), _) == False{} : Bool}
  and_false(Nat.is_lt(observed, cutoff))

def Laws.future_observations_are_excluded(cutoff, delay, mature):
  %Equal.sym(Bool, Nat.is_lt(Nat.add(cutoff, delay), cutoff), False{}, at_or_after_not_lt(cutoff, delay)) :
    {Bool.and(_, Nat.is_lt(mature, cutoff)) == False{} : Bool}
  {==}

def Laws.unavailable_bars_cannot_supply_execution(execution, delay, open):
  %Equal.sym(Bool, Nat.is_lt(Nat.add(execution, delay), execution), False{}, at_or_after_not_lt(execution, delay)) :
    {Bool.and(_, Nat.is_lt(open, execution)) == False{} : Bool}
  {==}

def Laws.bar_open_must_precede_execution(execution, delay, available):
  %Equal.sym(Bool, Nat.is_lt(Nat.add(execution, delay), execution), False{}, at_or_after_not_lt(execution, delay)) :
    {Bool.and(Nat.is_lt(available, execution), _) == False{} : Bool}
  and_false(Nat.is_lt(available, execution))

def Laws.ready_bar_executes_after_delay(open, delay):
  match open:
    case 0n:
      {==}
    case 1n+p:
      Laws.ready_bar_executes_after_delay(p, delay)

def Laws.compaction_preserves_ledger(ledger, orders):
  {==}

def Laws.working_orders_empty():
  {==}

def Laws.closed_orders_are_removed(id, side, limit, accepted, filled, cancelled, decision, arrival, cancel_at, tail):
  {==}

def Laws.working_orders_keep_fifo(id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at, tail):
  {==}

def Laws.future_market_data_is_hidden(decision, delay):
  match decision:
    case 0n:
      {==}
    case 1n+p:
      Laws.future_market_data_is_hidden(p, delay)

def Laws.published_market_data_is_visible(available, delay):
  match available:
    case 0n:
      match delay:
        case 0n:
          {==}
        case 1n+p:
          {==}
    case 1n+p:
      Laws.published_market_data_is_visible(p, delay)

def Laws.zero_bid_is_not_a_quote(ask, bid_size, ask_size):
  {==}

def Laws.locked_or_crossed_quotes_are_rejected(ask, delay, bid_size, ask_size):
  %Equal.sym(Bool, Nat.is_lt(Nat.add(ask, delay), ask), False{}, at_or_after_not_lt(ask, delay)) :
    {Bool.and(Nat.is_gt(Nat.add(ask, delay), 0n), Bool.and(_, Bool.and(Nat.is_gt(bid_size, 0n), Nat.is_gt(ask_size, 0n)))) == False{} : Bool}
  and_false(Nat.is_gt(Nat.add(ask, delay), 0n))

def Laws.positive_uncrossed_quotes_are_accepted(bid, spread, bid_size, ask_size):
  match bid:
    case 0n:
      {==}
    case 1n+p:
      Laws.positive_uncrossed_quotes_are_accepted(p, spread, bid_size, ask_size)
