import { Backtest } from './framework.mjs';
import { hash, nat, requireThat, freeze as freezeData } from './core.mjs';
import { validateTicks } from './data.mjs';
import { targetOrders } from './target-orders.mjs';

/** Bend cash venue. No InformationSource or source observation enters this module. */
export class QuoteExecutionVenue {
  #ticks; #tickIds; #cursor = 0; #time = null; #quote = null; #sequence = 0n; #orderId = 0n;
  #reconcile; #finished = false; #terminalSequence; #submitAtEnd;
  constructor(options) {
    requireThat(options && Object.keys(options).every(key => ['id', 'config', 'ticks', 'maxPositionLots', 'traceMode', 'orderStorage', 'submitAtEnd'].includes(key)), 'VENUE_OPTION', 'Unknown quote execution option');
    const { id, config, ticks, maxPositionLots, traceMode = 'full', orderStorage, submitAtEnd = true } = options;
    requireThat(typeof submitAtEnd === 'boolean', 'VENUE_OPTION', 'submitAtEnd must be boolean');
    requireThat(typeof id === 'string' && id.length > 0, 'EXECUTION_VENUE', 'Venue identity is required');
    this.#ticks = freezeData(validateTicks(ticks, { instrument: config.instrument }));
    this.#tickIds = new Set(this.#ticks.map(tick => tick.id));
    this.backtest = new Backtest(config, { traceMode, orderStorage });
    this.instrument = this.backtest.config.instrument;
    this.#reconcile = targetOrders(context => context.target, { feePerLot: this.backtest.config.feePerLot, maxPositionLots });
    this.#submitAtEnd = submitAtEnd;
    this.manifest = freezeData({ id, model: 'cash-spot-fifo-quote-v1', instrument: this.instrument,
      datasetHash: hash(this.#ticks), configHash: hash({ config: this.backtest.config, maxPositionLots, submitAtEnd }),
      funding: 'unsupported', margin: 'cash-only-no-leverage' });
    Object.freeze(this);
  }
  #base(id, time) {
    // Input IDs have no reserved namespace, including ticks still in the future.
    while (this.#tickIds.has(id)) id += '-';
    return { id, time, sequence: String(++this.#sequence), symbol: this.instrument.symbol, currency: this.instrument.currency };
  }
  advanceTo(time) {
    const now = nat(time, 'venue time');
    requireThat(!this.#finished && (this.#time === null || now >= this.#time), 'VENUE_TIME', 'Venue time must advance on an unfinished replay');
    while (this.#cursor < this.#ticks.length && BigInt(this.#ticks[this.#cursor].time) <= now) {
      const tick = this.#ticks[this.#cursor++];
      this.backtest.step({ ...tick, sequence: String(++this.#sequence) });
      this.#quote = tick;
    }
    if (this.backtest.lastTime !== now) this.backtest.step({ ...this.#base(`venue-clock-${this.#sequence + 1n}`, time), type: 'clock' });
    this.#time = now;
  }
  snapshot() {
    const ledger = this.backtest.ledger, mark = this.backtest.mark;
    const stale = !mark || this.#time - mark.time > BigInt(this.backtest.config.maxQuoteAgeMs);
    return freezeData({ ledger: { cash: ledger.cash, quantity: ledger.quantity },
      orders: this.backtest.workingOrders.map(order => ({ id: order.id, side: order.side.$ === 'Buy' ? 'buy' : 'sell',
        limit: order.limit, remaining: order.remaining, cancellationPending: order.cancel_at.$ === 'Some' })),
      equity: ledger.quantity > 0n && stale ? null : ledger.cash + ledger.quantity * (mark?.price ?? 0n),
      funding: { status: 'unsupported', accrued: null }, margin: { model: 'cash-only', leverage: false } });
  }
  setTarget(target, time) { this.reconcileTarget(target, time, this.#quote); }
  // Internal seam used by the explicit bar-price proxy for venue-owned collars.
  reconcileTarget(target, time, quote) {
    nat(target, 'target');
    requireThat(!this.#finished && this.#time === nat(time, 'decision time'), 'VENUE_TIME', 'Advance venue before setting a target');
    if (!quote || (!this.#submitAtEnd && this.#cursor === this.#ticks.length) || this.#time - BigInt(quote.time) > BigInt(this.backtest.config.maxQuoteAgeMs)) return;
    const decisions = this.#reconcile({ target, history: [quote], ledger: this.backtest.ledger, orders: this.backtest.workingOrders });
    for (const decision of decisions) {
      const event = { ...decision, ...this.#base(`strategy-${this.#sequence + 1n}`, time) };
      if (decision.type === 'submit') event.orderId = String(++this.#orderId);
      this.backtest.step(event);
    }
  }
  finish(time) {
    requireThat(!this.#finished, 'VENUE_REUSED', 'Venue already finished');
    if (time !== null) this.advanceTo(time);
    this.#finished = true; this.#terminalSequence = this.backtest.lastSequence;
  }
  report() {
    requireThat(this.#finished && this.backtest.lastSequence === this.#terminalSequence, 'VENUE_REPLAY_CHANGED', 'Venue reports require an unchanged completed replay');
    return this.backtest.report();
  }
}
