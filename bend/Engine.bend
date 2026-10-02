import Base

# Exact reference model. Money is quote minor units; quantity is whole lots.
# This module is pure: validation of JSON, identities and chronology is external.
type Side is Data:
  Buy{}
  Sell{}

type Ledger is Data:
  Ledger{cash: Nat, quantity: Nat}

type Order is Data:
  Order{id: Nat, side: Side, limit: Nat, accepted: Nat, remaining: Nat,
        filled: Nat, cancelled: Nat, decision: Nat, arrival: Nat,
        cancel_at: Maybe<&2, Nat>}

type State is Data:
  State{ledger: Ledger, orders: List<&2, Order>}

type Admission is Data:
  Accepted{state: State}
  Rejected{state: State}

type Allocation is Data:
  Allocation{ledger: Ledger, orders: List<&2, Order>, bids: Nat, asks: Nat}

def cost(price: Nat, quantity: Nat, fee: Nat) -> Nat:
  Nat.mul(quantity, Nat.add(price, fee))

# Callers must establish sufficient cash / inventory before these postings.
def buy(cash: Nat, quantity: Nat, price: Nat, +lots: Nat, fee: Nat) -> Ledger:
  Ledger{Nat.sub(cash, cost(price, lots, fee)), Nat.add(quantity, lots)}

def sell(cash: Nat, quantity: Nat, +price: Nat, +lots: Nat, fee: Nat) -> Ledger:
  Ledger{Nat.add(cash, Nat.mul(lots, Nat.sub(price, fee))), Nat.sub(quantity, lots)}

def equity(ledger: Ledger, mark: Nat) -> Nat:
  match ledger:
    case Ledger{cash, quantity}:
      Nat.add(cash, Nat.mul(quantity, mark))

def cancel(order: Order) -> Order:
  match order:
    case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
      Order{id, side, limit, accepted, 0n, filled, Nat.add(remaining, cancelled), decision, arrival, None{}}

def cancel_if(due: Bool, order: Order) -> Order:
  match due:
    case True{}:
      cancel(order)
    case False{}:
      order

def advance_order(+order: Order, time: Nat) -> Order:
  match order:
    case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
      match cancel_at:
        case None{}:
          order
        case Some{at}:
          cancel_if(Nat.is_le(at, time), order)

def advance_orders(orders: List<&2, Order>, +time: Nat) -> List<&2, Order>:
  match orders:
    case Nil{}:
      Nil{}
    case Con{head, tail}:
      Con{advance_order(head, time), advance_orders(tail, time)}

def advance(state: State, time: Nat) -> State:
  match state:
    case State{ledger, orders}:
      State{ledger, advance_orders(orders, time)}

# Closed-order records live in the host's immutable audit archive. Only working
# orders need matching/reservation scans; filtering preserves their FIFO order.
def working_orders(orders: List<&2, Order>) -> List<&2, Order>:
  match orders:
    case Nil{}:
      Nil{}
    case Con{+head, tail}:
      match head:
        case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
          match remaining:
            case 0n:
              working_orders(tail)
            case 1n+r:
              Con{head, working_orders(tail)}

def compact_state(state: State) -> State:
  match state:
    case State{ledger, orders}:
      State{ledger, working_orders(orders)}

def reserve_order(order: Order, fee: Nat) -> Nat:
  match order:
    case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
      match side:
        case Buy{}:
          cost(limit, remaining, fee)
        case Sell{}:
          0n

def reserve_cash(orders: List<&2, Order>, +fee: Nat) -> Nat:
  match orders:
    case Nil{}:
      0n
    case Con{head, tail}:
      Nat.add(reserve_order(head, fee), reserve_cash(tail, fee))

def reserve_quantity(orders: List<&2, Order>) -> Nat:
  match orders:
    case Nil{}:
      0n
    case Con{head, tail}:
      match head:
        case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
          match side:
            case Buy{}:
              reserve_quantity(tail)
            case Sell{}:
              Nat.add(remaining, reserve_quantity(tail))

def append(orders: List<&2, Order>, order: Order) -> List<&2, Order>:
  match orders:
    case Nil{}:
      Con{order, Nil{}}
    case Con{head, tail}:
      Con{head, append(tail, order)}

def can_admit(ledger: Ledger, +orders: List<&2, Order>, side: Side, price: Nat, lots: Nat, +fee: Nat) -> Bool:
  match ledger:
    case Ledger{cash, quantity}:
      match side:
        case Buy{}:
          Nat.is_le(cost(price, lots, fee), Nat.sub(cash, reserve_cash(orders, fee)))
        case Sell{}:
          Bool.and(Nat.is_ge(price, fee), Nat.is_le(lots, Nat.sub(quantity, reserve_quantity(orders))))

def admit_if(ok: Bool, state: State, order: Order) -> Admission:
  match ok:
    case True{}:
      match state:
        case State{ledger, orders}:
          Accepted{State{ledger, append(orders, order)}}
    case False{}:
      Rejected{state}

def submit(+state: State, id: Nat, +side: Side, +price: Nat, +lots: Nat, decision: Nat, arrival: Nat, fee: Nat) -> Admission:
  match state:
    case State{ledger, orders}:
      ok = Bool.and(Nat.is_gt(lots, 0n), Bool.and(Nat.is_gt(price, 0n), can_admit(ledger, orders, side, price, lots, fee)))
      admit_if(ok, state, Order{id, side, price, lots, lots, 0n, 0n, decision, arrival, None{}})

def earliest(at: Maybe<&2, Nat>, time: Nat) -> Maybe<&2, Nat>:
  match at:
    case None{}:
      Some{time}
    case Some{old}:
      Some{Nat.min(old, time)}

def request_if(same: Bool, order: Order, time: Nat) -> Order:
  match same:
    case False{}:
      order
    case True{}:
      match order:
        case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
          Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, earliest(cancel_at, time)}

def request_orders(orders: List<&2, Order>, +id: Nat, +time: Nat) -> List<&2, Order>:
  match orders:
    case Nil{}:
      Nil{}
    case Con{+head, tail}:
      match head:
        case Order{order_id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
          Con{request_if(Nat.is_eq(order_id, id), head, time), request_orders(tail, id, time)}

def request_cancel(state: State, id: Nat, time: Nat) -> State:
  match state:
    case State{ledger, orders}:
      State{ledger, request_orders(orders, id, time)}

def fill_order(order: Order, +lots: Nat) -> Order:
  match order:
    case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
      Order{id, side, limit, accepted, Nat.sub(remaining, lots), Nat.add(filled, lots), cancelled, decision, arrival, cancel_at}

def eligible(+time: Nat, +order: Order, bid: Nat, ask: Nat) -> Bool:
  match order:
    case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
      # Strictly newer quotes prevent same-timestamp decision data from filling.
      match side:
        case Buy{}:
          Bool.and(Bool.and(Nat.is_gt(time, decision), Nat.is_ge(time, arrival)), Nat.is_le(ask, limit))
        case Sell{}:
          Bool.and(Bool.and(Nat.is_gt(time, decision), Nat.is_ge(time, arrival)), Nat.is_ge(bid, limit))

def allocate_side(side: Side, ledger: Ledger, +order: Order, bid: Nat, ask: Nat, +bids: Nat, +asks: Nat, fee: Nat) -> Allocation:
  match side:
    case Buy{}:
      match ledger:
        case Ledger{cash, quantity}:
          match order:
            case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
              +lots = Nat.min(remaining, asks)
              Allocation{buy(cash, quantity, ask, lots, fee), Con{fill_order(order, lots), Nil{}}, bids, Nat.sub(asks, lots)}
    case Sell{}:
      match ledger:
        case Ledger{cash, quantity}:
          match order:
            case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
              +lots = Nat.min(remaining, bids)
              Allocation{sell(cash, quantity, bid, lots, fee), Con{fill_order(order, lots), Nil{}}, Nat.sub(bids, lots), asks}

def allocate_if(ok: Bool, ledger: Ledger, +order: Order, bid: Nat, ask: Nat, bids: Nat, asks: Nat, fee: Nat) -> Allocation:
  match ok:
    case False{}:
      Allocation{ledger, Con{order, Nil{}}, bids, asks}
    case True{}:
      match order:
        case Order{id, side, limit, accepted, remaining, filled, cancelled, decision, arrival, cancel_at}:
          allocate_side(side, ledger, order, bid, ask, bids, asks, fee)

def prepend(head: List<&2, Order>, rest: Allocation) -> Allocation:
  match head:
    case Nil{}:
      rest
    case Con{order, tail}:
      match rest:
        case Allocation{ledger, orders, bids, asks}:
          Allocation{ledger, Con{order, orders}, bids, asks}

def continue_allocation(allocation: Allocation, next: Ledger -> Nat -> Nat -> Allocation) -> Allocation:
  match allocation:
    case Allocation{ledger, orders, bids, asks}:
      prepend(orders, next(ledger, bids, asks))

def allocate(orders: List<&2, Order>, ledger: Ledger, +time: Nat, +bid: Nat, +ask: Nat, bids: Nat, asks: Nat, +fee: Nat) -> Allocation:
  match orders:
    case Nil{}:
      Allocation{ledger, Nil{}, bids, asks}
    case Con{+head, tail}:
      allocation = allocate_if(eligible(time, head, bid, ask), ledger, head, bid, ask, bids, asks, fee)
      continue_allocation(allocation, l => b => a => allocate(tail, l, time, bid, ask, b, a, fee))

def allocated_state(allocation: Allocation) -> State:
  match allocation:
    case Allocation{ledger, orders, bids, asks}:
      State{ledger, orders}

def tick(state: State, time: Nat, bid: Nat, ask: Nat, bids: Nat, asks: Nat, fee: Nat) -> State:
  match state:
    case State{ledger, orders}:
      allocated_state(allocate(orders, ledger, time, bid, ask, bids, asks, fee))

def initial(cash: Nat) -> State:
  State{Ledger{cash, 0n}, Nil{}}

def replay(events: List<&2, Nat>, state: State) -> State:
  # Replay of clock advances, including effective cancellations.
  match events:
    case Nil{}:
      state
    case Con{time, tail}:
      replay(tail, advance(state, time))

