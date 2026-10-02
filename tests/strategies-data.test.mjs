import { targetOrders } from '../src/target-orders.mjs';
import { replayQuotes as runStrategy } from './replay-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BacktestError, MAX_NAT } from '../src/core.mjs';
import { QUOTE_UNITS, parseQuoteCsv, syntheticQuotes, validateTicks } from '../src/data.mjs';
import { targetPosition, buyAndHold, movingAverageCrossover, meanReversion } from '../src/strategies.mjs';

const instrument = { symbol: 'TEST', currency: 'EUR', priceTick: '1', lotSize: '1' };
const config = (extra = {}) => ({ instrument, initialCash: '1000', feePerLot: '1', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '100',
  manifest: { datasetVersion: 'strategy-test-v1', strategyArtifact: 'test', evaluationProtocol: 'deterministic-fixture', seed: '1' }, ...extra });
const ticks = (asks, volume = '100') => asks.map((ask, index) => ({ id: `q${index}`, type: 'tick', time: String(index), sourceTime: String(index), sequence: String(index + 1), ...{ symbol: instrument.symbol, currency: instrument.currency },
  bid: String(BigInt(ask) - 1n), ask: String(ask), bidLots: volume, askLots: volume }));
const errorCode = code => error => error instanceof BacktestError && error.code === code;
const mapping = { time: 'timestamp', bid: 'bid', ask: 'ask', bidLots: 'bid_depth', askLots: 'ask_depth' };
const csvOptions = (extra = {}) => ({ instrument, columns: mapping, units: QUOTE_UNITS, ...extra });
const header = 'timestamp,bid,ask,bid_depth,ask_depth';

test('CSV handles quoted headers, escaped delimiters, multiline IDs, BOM and CRLF exactly', () => {
  const csv = '\ufeff"timestamp","bid","ask","bid_depth","ask_depth","identity"\r\n0,99,100,2,3,"vendor, ""one"""\r\n1,100,101,4,5,"line\nidentifier"\r\n';
  const result = parseQuoteCsv(csv, csvOptions({ columns: { ...mapping, id: 'identity' } }));
  assert.deepEqual(result.map(quote => quote.id), ['vendor, "one"', 'line\nidentifier']);
  assert.equal(result[0].bid, '99'); assert.equal(result[1].sequence, '2');
  assert.equal(result[1].sourceTime, '1');
});
test('CSV requires units and columns; never infers decimal, timestamp or lot scaling', () => {
  const csv = `${header}\n0,99,100,2,3\n`;
  assert.throws(() => parseQuoteCsv(csv, { instrument, columns: mapping }), errorCode('DATA_UNITS'));
  assert.throws(() => parseQuoteCsv(csv, csvOptions({ units: { ...QUOTE_UNITS, price: 'EUR' } })), errorCode('DATA_UNITS'));
  assert.throws(() => parseQuoteCsv(csv, csvOptions({ columns: undefined })), errorCode('CSV_COLUMNS'));
  assert.throws(() => parseQuoteCsv(csv.replace('99', '0.99'), csvOptions()), errorCode('INVALID_INTEGER'));
  assert.throws(() => parseQuoteCsv(csv.replace('0,99', '2026-10-02T00:00:00Z,99'), csvOptions()), errorCode('INVALID_INTEGER'));
  assert.throws(() => parseQuoteCsv(csv.replace('2,3', '02,3'), csvOptions()), errorCode('INVALID_INTEGER'));
});
test('CSV rejects malformed quoting, duplicate headers, incomplete rows and empty records', () => {
  for (const [csv, code] of [
    [`${header}\n0,"99,100,2,3`, 'CSV_SYNTAX'],
    [`${header}\n0,"99"x,100,2,3`, 'CSV_SYNTAX'],
    [`${header}\n0,9"9,100,2,3`, 'CSV_SYNTAX'],
    [`${header},bid\n0,99,100,2,3,99`, 'CSV_HEADER'],
    [`${header}\n0,99,100,2`, 'CSV_WIDTH'],
    [`${header}\n0,99,100,2,3\n\n`, 'CSV_WIDTH'],
    [header, 'CSV_EMPTY'],
  ]) assert.throws(() => parseQuoteCsv(csv, csvOptions()), errorCode(code));
});
test('ingestion rejects reordering, duplicate identity, crossed quotes and delayed source time', () => {
  assert.throws(() => parseQuoteCsv(`${header}\n2,99,100,2,3\n1,99,100,2,3`, csvOptions()), errorCode('OUT_OF_ORDER'));
  assert.throws(() => parseQuoteCsv(`${header},seq\n1,99,100,2,3,5\n1,99,100,2,3,4`, csvOptions({ columns: { ...mapping, sequence: 'seq' } })), errorCode('OUT_OF_ORDER'));
  assert.throws(() => parseQuoteCsv(`${header},id\n1,99,100,2,3,same\n2,99,100,2,3,same`, csvOptions({ columns: { ...mapping, id: 'id' } })), errorCode('DATA_DUPLICATE'));
  assert.throws(() => parseQuoteCsv(`${header}\n1,101,100,2,3`, csvOptions()), errorCode('CROSSED_QUOTE'));
  assert.throws(() => parseQuoteCsv(`${header},source\n1,99,100,2,3,0`, csvOptions({ columns: { ...mapping, sourceTime: 'source' } })), errorCode('NON_EXECUTABLE_QUOTE'));
  assert.throws(() => parseQuoteCsv(`${header},currency\n1,99,100,2,3,USD`, csvOptions({ columns: { ...mapping, currency: 'currency' } })), errorCode('UNIT_MISMATCH'));
});
test('quote validator clones inputs and rejects off-tick, extra fields and integer overflow', () => {
  const source = ticks([100, 101]); const copy = validateTicks(source, { instrument });
  copy[0].bid = '1'; assert.equal(source[0].bid, '99');
  assert.throws(() => validateTicks(source, { instrument: { ...instrument, priceTick: '2' } }), errorCode('PRICE_TICK'));
  assert.throws(() => validateTicks([{ ...source[0], volume: '9' }], { instrument }), errorCode('DATA_SCHEMA'));
  assert.throws(() => validateTicks([{ ...source[0], askLots: String(MAX_NAT + 1n) }], { instrument }), errorCode('INTEGER_RANGE'));
});
test('synthetic quotes are reproducible, seed-specific, on tick and depth bounded', () => {
  const options = { instrument: { ...instrument, priceTick: '5' }, count: 100, seed: '32', initialBid: '500', spreadTicks: '2', volatilityTicks: '4', stepMs: '7', minLots: '0', maxLots: '8' };
  const first = syntheticQuotes(options);
  assert.deepEqual(first, syntheticQuotes(options));
  assert.notDeepEqual(first.map(q => [q.bid, q.askLots]), syntheticQuotes({ ...options, seed: '33' }).map(q => [q.bid, q.askLots]));
  for (const [index, quote] of first.entries()) {
    assert.equal(BigInt(quote.bid) % 5n, 0n); assert.equal(BigInt(quote.ask) - BigInt(quote.bid), 10n);
    assert.equal(quote.time, String(index * 7));
    assert.ok(BigInt(quote.bidLots) >= 0n && BigInt(quote.bidLots) <= 8n);
    assert.ok(BigInt(quote.askLots) >= 0n && BigInt(quote.askLots) <= 8n);
  }
  assert.throws(() => syntheticQuotes({ ...options, seed: '0' }), errorCode('INTEGER_RANGE'));
  assert.throws(() => syntheticQuotes({ ...options, count: 1.5 }), errorCode('SYNTHETIC_COUNT'));
  assert.throws(() => syntheticQuotes({ ...options, minLots: '9' }), errorCode('SYNTHETIC_CONFIG'));
});

function assertExecutionSafety(run, cap) {
  for (const trace of run.trace) {
    const active = trace.orders.filter(order => order.remaining > 0n);
    assert.ok(active.length <= 1, 'target adapter must not stack working orders');
    const pendingBuys = active.filter(order => order.side.$ === 'Buy').reduce((total, order) => total + order.remaining, 0n);
    assert.ok(trace.ledger.quantity + pendingBuys <= BigInt(cap));
    assert.ok(trace.reservations.cashReserved <= trace.ledger.cash);
    assert.ok(trace.reservations.quantityReserved <= trace.ledger.quantity);
    assert.notEqual(trace.status, 'rejected-capital-or-fee');
  }
  for (const fill of run.fills) { assert.ok(fill.executionTime > fill.decisionTime); assert.ok(fill.executionTime >= fill.exchangeArrival); }
}
test('buy-and-hold uses fee-aware affordability, survives latency and never stacks pending exposure', () => {
  const strategy = buyAndHold({ quantity: '20' });
  const run = runStrategy(config({ orderLatencyMs: '3' }), ticks(Array(10).fill(100), '2'), strategy);
  assert.equal(run.state.ledger.quantity, 9n); assert.equal(run.state.ledger.cash, 91n);
  assert.equal(run.events.filter(event => event.type === 'submit').length, 1);
  assert.equal(run.fills[0].executionTime, 3n); assertExecutionSafety(run, '20');
});
test('stale orders are cancelled; delayed cancellation must finish before replacement', () => {
  const run = runStrategy(config({ orderLatencyMs: '3', cancelLatencyMs: '2' }), ticks([100, 105, 105, 105, 105, 105, 105, 105]), buyAndHold({ quantity: '3' }));
  assert.deepEqual(run.events.filter(e => e.type === 'submit').map(e => [e.time, e.limit]), [['0', '100'], ['3', '105']]);
  assert.deepEqual(run.events.filter(e => e.type === 'cancel').map(e => e.time), ['1']);
  assert.equal(run.state.ledger.quantity, 3n); assert.equal(run.fills[0].executionTime, 6n);
  assertExecutionSafety(run, '3');
});
test('a fill while cancellation is in flight is reconciled without replacement overexposure', () => {
  const run = runStrategy(config({ orderLatencyMs: '2', cancelLatencyMs: '3' }), ticks([100, 105, 99, 99, 99, 99]), buyAndHold({ quantity: '3' }));
  assert.equal(run.events.filter(e => e.type === 'submit').length, 1);
  assert.equal(run.state.ledger.quantity, 3n); assert.equal(run.fills[0].executionTime, 2n);
  assertExecutionSafety(run, '3');
});
test('target callbacks cap requested positions and rebalance to flat without naked sales', () => {
  const strategy = targetPosition(({ tickCount }) => tickCount < 4 ? '100' : '0', { maxPositionLots: '4' });
  const run = runStrategy(config(), ticks(Array(8).fill(100), '2'), strategy);
  assert.equal(run.state.ledger.quantity, 0n);
  assert.deepEqual(run.events.filter(e => e.type === 'submit').map(e => [e.side, e.quantity]), [['buy', '4'], ['sell', '4']]);
  assert.equal(run.report().performance.fees, '8'); assertExecutionSafety(run, '4');
});
test('strategy warmup, invalid parameters, high fees and zero capital fail safely', () => {
  let callbacks = 0;
  const strategy = targetPosition(() => { callbacks++; return '3'; }, { warmup: 4, maxPositionLots: '3' });
  const run = runStrategy(config(), ticks([100, 100, 100]), strategy);
  assert.equal(callbacks, 0); assert.equal(run.events.length, 3);
  assert.equal(buyAndHold({ quantity: '3' })({ history: ticks([100]) }), '3');
  assert.throws(() => movingAverageCrossover({ fast: 3, slow: 3, quantity: '1' }), errorCode('STRATEGY_PARAMETER'));
  assert.throws(() => meanReversion({ entryBps: '100', exitBps: '100', quantity: '1' }), errorCode('STRATEGY_PARAMETER'));
  assert.throws(() => targetPosition(() => 1, { maxPositionLots: '1' })({ history: ticks([100]), ledger: { cash: 1000n, quantity: 0n }, orders: [] }), errorCode('INVALID_INTEGER'));
  assert.deepEqual(targetOrders('1', { feePerLot: '1', maxPositionLots: '1' })({ history: ticks([100]), ledger: { cash: 0n, quantity: 0n }, orders: [] }), []);
  assert.deepEqual(targetOrders('0', { feePerLot: '100', maxPositionLots: '1' })({ history: ticks([100]), ledger: { cash: 0n, quantity: 1n }, orders: [] }), []);
});
test('moving average and mean reversion trade using actual Bend accounting and executable quotes', () => {
  const scenarios = [
    { ticks: ticks([100, 100, 100, 110, 110, 109, 100, 100, 100]), strategy: movingAverageCrossover({ fast: 2, slow: 3, quantity: '2' }), firstDecision: '3' },
    { ticks: ticks([100, 100, 100, 90, 89, 95, 100, 100, 100]), strategy: meanReversion({ window: 3, entryBps: '500', quantity: '2' }), firstDecision: '3' },
  ];
  for (const scenario of scenarios) {
    const run = runStrategy(config(), scenario.ticks, scenario.strategy);
    assert.equal(run.events.find(e => e.type === 'submit').time, scenario.firstDecision);
    assert.deepEqual(run.fills.map(fill => fill.side), ['buy', 'sell']);
    assert.equal(run.state.ledger.quantity, 0n); assert.equal(run.report().performance.fees, '4');
    assertExecutionSafety(run, '2');
  }
});
test('built-in strategies are replayable and prefix invariant with no future or same-timestamp fills', () => {
  const quotes = syntheticQuotes({ instrument, count: 50, seed: '91', volatilityTicks: '8', minLots: '0', maxLots: '3' });
  for (const strategy of [buyAndHold({ quantity: '3' }), movingAverageCrossover({ fast: 2, slow: 5, quantity: '3' }), meanReversion({ window: 4, entryBps: '100', quantity: '3' })]) {
    const full = runStrategy(config(), quotes, strategy);
    const prefix = runStrategy(config(), quotes.slice(0, 23), strategy);
    assert.deepEqual(full.trace.slice(0, prefix.trace.length), prefix.trace);
    assert.deepEqual(runStrategy(config(), quotes, strategy).trace, full.trace);
    assertExecutionSafety(full, '3');
  }
  const sameTime = ticks([100, 100, 100]).map(quote => ({ ...quote, time: '0', sourceTime: '0' }));
  const run = runStrategy(config(), sameTime, buyAndHold({ quantity: '1' }));
  assert.equal(run.fills.length, 0); assert.equal(run.events.filter(e => e.type === 'submit').length, 1);
});
test('seeded stress cases preserve capital, position caps and one working order through target flips', () => {
  for (const seed of ['1', '7', '29', '4294967295']) {
    for (const [orderLatencyMs, cancelLatencyMs] of [['0', '0'], ['2', '5'], ['5', '2']]) {
      const quotes = syntheticQuotes({ instrument, count: 60, seed, initialBid: '100', volatilityTicks: '7', minLots: '0', maxLots: '2' });
      const strategy = targetPosition(({ tickCount }) => tickCount % 9 < 4 ? '5' : '0', { maxPositionLots: '5' });
      const run = runStrategy(config({ initialCash: '450', feePerLot: '3', orderLatencyMs, cancelLatencyMs }), quotes, strategy);
      assertExecutionSafety(run, '5');
      const cashFromFills = run.fills.reduce((cash, fill) => cash + (fill.side === 'buy' ? -fill.price * fill.quantity : fill.price * fill.quantity) - fill.fee, 450n);
      const quantityFromFills = run.fills.reduce((position, fill) => position + (fill.side === 'buy' ? fill.quantity : -fill.quantity), 0n);
      assert.equal(run.state.ledger.cash, cashFromFills); assert.equal(run.state.ledger.quantity, quantityFromFills);
      assert.equal(run.report().status, 'valid-under-declared-model');
    }
  }
});
