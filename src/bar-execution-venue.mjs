import { checked, hash, nat, requireThat, freeze as freezeData } from './core.mjs';
import { barExecutionAllowed, cappedLots } from './policies.mjs';
import { validateBars } from './bars.mjs';
import { QuoteExecutionVenue } from './execution-venue.mjs';
import { ReplayRecording } from './recording.mjs';
import { join } from 'node:path';

const ceilDiv = (value, denominator) => (value + denominator - 1n) / denominator;
function spread(price, bps, tick) {
  const bid = price * (10000n - bps) / (10000n * tick) * tick;
  const ask = ceilDiv(price * (10000n + bps), 10000n * tick) * tick;
  requireThat(bid > 0n, 'BAR_PRICE_RANGE', 'Spread rounds bid to zero');
  return { bid: String(checked(bid, 'modeled bid')), ask: String(checked(ask, 'modeled ask')) };
}

/** Explicit cash-price proxy over the execution venue's own bars. */
export class BarExecutionVenue {
  #venue; #bars; #cursor = 0; #lastBar = null; #collar; #tickSize; #assumptions; #evidence;
  #recording;
  constructor(options) {
    requireThat(options && Object.keys(options).every(key => ['id', 'config', 'bars', 'maxPositionLots', 'halfSpreadBps', 'participationBps', 'maxLiquidityLots', 'limitBufferBps', 'executionDelayMs', 'traceMode', 'orderStorage', 'auditDirectory'].includes(key)), 'BAR_OPTION', 'Unknown bar execution option');
    const { id, config, bars, maxPositionLots, halfSpreadBps = '2', participationBps = '10', maxLiquidityLots = '10000',
      limitBufferBps = '100', executionDelayMs = '1', traceMode = 'compact', orderStorage = 'active', auditDirectory } = options;
    nat(maxPositionLots, 'maxPositionLots'); nat(maxLiquidityLots, 'maxLiquidityLots');
    const half = nat(halfSpreadBps, 'halfSpreadBps'), participation = nat(participationBps, 'participationBps');
    this.#collar = nat(limitBufferBps, 'limitBufferBps'); this.#tickSize = nat(config.instrument.priceTick, 'priceTick', true);
    requireThat(half < 10000n && participation <= 10000n && this.#collar < 10000n, 'BAR_OPTION', 'Require spread/collar <10000 bps and participation <=10000 bps');
    const delay = nat(executionDelayMs, 'executionDelayMs', true);
    this.#bars = validateBars(bars, config.instrument);
    const duration = BigInt(this.#bars[0].availableAt) - BigInt(this.#bars[0].openTime);
    requireThat(delay < duration, 'BAR_TIMING', 'Execution delay must fit within the following bar');
    requireThat(BigInt(config.orderLatencyMs) <= delay, 'BAR_TIMING', 'Order latency cannot exceed modeled execution delay');
    const ticks = [], evidence = [];
    for (let index = 0; index < this.#bars.length; index++) {
      const bar = this.#bars[index], previous = this.#bars[index - 1];
      const executionTime = checked(BigInt(bar.openTime) + delay, 'bar execution time');
      const opening = spread(BigInt(bar.open), half, this.#tickSize);
      const budget = previous ? BigInt(previous.volumeLots) * participation / 10000n : 0n;
      const liquidity = cappedLots(String(checked(budget, 'participation budget')), maxLiquidityLots, maxLiquidityLots);
      if (previous) requireThat(barExecutionAllowed({ availableAt: previous.availableAt, openTime: bar.openTime, executionTime: String(executionTime) }), 'BAR_CAUSALITY', 'Execution must follow availability and next open');
      const tick = (id, time, prices, lots) => ({ id, type: 'tick', time: String(time), sourceTime: String(time), sequence: String(ticks.length + 1),
        symbol: config.instrument.symbol, currency: config.instrument.currency, ...prices, bidLots: lots, askLots: lots });
      ticks.push(tick(`bar-open-${index}`, executionTime, opening, liquidity));
      ticks.push(tick(`bar-close-${index}`, bar.availableAt, spread(BigInt(bar.close), half, this.#tickSize), '0'));
      evidence.push({ eventId: `bar-open-${index}`, executionTime: String(executionTime), openTime: bar.openTime,
        sourceOpen: bar.open, priorAvailableAt: previous?.availableAt ?? null, priorVolumeLots: previous?.volumeLots ?? '0', ...opening, budgetPerSide: liquidity });
    }
    this.#venue = new QuoteExecutionVenue({ id, config, ticks, maxPositionLots, traceMode, orderStorage, submitAtEnd: false, auditDirectory });
    this.instrument = this.#venue.instrument;
    this.backtest = this.#venue.backtest;
    this.#assumptions = freezeData({ model: 'completed-bar-next-open-cash-price-proxy-v1',
      account: 'Cash-only long/flat spot-style proxy; no perpetual contract, funding, leverage, liquidation or exchange fee schedule; margin unsupported',
      execution: 'Hypothetical bid/ask from execution-venue bar opens plus delay; open held fixed during delay',
      timing: 'Process venue events through decision availability; fills strictly after decisions; no final-bar orders',
      liquidity: 'Capped participation in the execution venue previous completed bar volume; no signal-source volume',
      limits: 'Execution-venue completed-close collar; gaps may not fill; pending cancellations may miss openings',
      stops: 'No assumed intrabar high/low ordering', costs: 'Modeled spread plus venue-configured fixed fee per filled lot',
      halfSpreadBps, participationBps, maxLiquidityLots, limitBufferBps, executionDelayMs, maxPositionLots, orderStorage });
    this.#recording = new ReplayRecording(auditDirectory === undefined ? undefined : join(auditDirectory,'bar-inputs'));
    this.#evidence = this.#recording.series('executionInputs');
    this.#recording.transaction(()=>{ for(const item of evidence) this.#evidence.push(item); });
    this.manifest = freezeData({ ...this.#venue.manifest, model: this.#assumptions.model,
      datasetHash: hash(this.#bars), configHash: hash({ config: this.backtest.config, assumptions: this.#assumptions }) });
    Object.freeze(this);
  }
  advanceTo(time) {
    this.#venue.advanceTo(time);
    while (this.#cursor < this.#bars.length && BigInt(this.#bars[this.#cursor].availableAt) <= BigInt(time)) this.#lastBar = this.#bars[this.#cursor++];
  }
  snapshot() { return this.#venue.snapshot(); }
  setTarget(target, time) {
    const bar = this.#lastBar;
    this.#venue.reconcileTarget(target, time, bar ? { time: bar.availableAt, ...spread(BigInt(bar.close), this.#collar, this.#tickSize) } : null);
  }
  finish(time) { this.#venue.finish(time); }
  abort() { this.#venue.abort(); this.#recording.abort(); }
  report(options = {}) {
    const detail = options.detail ?? (this.#recording.disk ? 'summary' : 'full');
    const report = this.#venue.report(options);
    const executionAudit = this.#recording.disk ? this.#recording.seal({model:this.#assumptions.model}) : null;
    return { ...report, barReplay: { assumptions: this.#assumptions,
      ...(detail==='full' ? {executionInputs:freezeData(this.#evidence.slice())} : {}),
      ...(executionAudit ? {executionAudit} : {}) } };
  }
}
