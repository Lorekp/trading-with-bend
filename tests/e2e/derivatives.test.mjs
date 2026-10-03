import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DerivativeExecutionVenue, validateDerivativeData, InformationSource, runStrategy, targetPosition, listExperiments, verifyExperimentArtifacts, hash } from '../../src/index.mjs';

const instrument = { symbol: 'TEST-PERP', currency: 'USD', lotSize: '1', priceTick: '1' };
function config(payoff = 'linear', overrides = {}) {
  return { instrument, contract: { kind: 'perpetual', payoff, contractValue: '1', settlementScale: payoff === 'inverse' ? '1000000' : '1', fundingIntervalMs: '10', fundingOffsetMs: '5' },
    initialCash: '10000', maxPositionLots: '100', initialMarginBps: '1000', maintenanceMarginBps: '500',
    feeBps: '0', liquidationFeeBps: '0', slippageBps: '0', orderLatencyMs: '0', cancelLatencyMs: '0', maxQuoteAgeMs: '10', maxMarkAgeMs: '10', ...overrides };
}
function data(rows, endTime = rows.at(-1)[1]) {
  return { startTime: '0', endTime: String(endTime), events: rows.map(([type, time, price, extra = {}], i) => ({
    id: `event-${i}`, type, time: String(time), sourceTime: String(time), sequence: String(i + 1), symbol: instrument.symbol, currency: instrument.currency,
    ...(type === 'quote' ? { bid: String(price), ask: String(price), bidLots: '100', askLots: '100' } : { price: String(price) }), ...extra,
  })) };
}
function replay(configuration, dataset, signals) {
  const venue = new DerivativeExecutionVenue({ id: 'test', config: configuration, data: dataset });
  const source = new InformationSource({ id: 'signals', instrument, observations: signals.map(([time, target]) => ({ time: String(time), availableAt: String(time), data: { target } })) });
  return runStrategy(source, venue, ({ observation }) => observation.target).report();
}
const base = [['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['mark', 2, 110], ['quote', 2, 110], ['quote', 3, 110], ['funding', 5, 110, { ratePpm: '10000' }], ['mark', 6, 110], ['quote', 6, 110], ['quote', 7, 110]];

for (const payoff of ['linear', 'inverse']) {
  test(`${payoff}: independent information drives partial closes, reversal, funding and exact P&L`, () => {
    const report = replay(config(payoff), data(base), [[0, '4'], [2, '2'], [3, '-3'], [6, '0'], [7, null]]);
    // The reversal is submitted at 3, and executes at 6; funding at 5 is paid by 2 longs.
    assert.deepEqual(report.fills.map(f => [f.time, f.side, f.quantity]), [['1', 'buy', '4'], ['3', 'sell', '2'], ['6', 'sell', '5'], ['7', 'buy', '3']]);
    assert.equal(report.terminal.ledger.quantity, '0');
    assert.equal(report.performance.realizedPnl, payoff === 'linear' ? '40' : '3636');
    assert.equal(report.performance.funding, payoff === 'linear' ? '-3' : '-182');
    assert.equal(report.performance.netPnl, payoff === 'linear' ? '37' : '3454');
    assert.equal(report.status, 'valid-under-declared-model');
    assert.equal(report.traceHash, replay(config(payoff), data(base), [[0, '4'], [2, '2'], [3, '-3'], [6, '0'], [7, null]]).traceHash);
    assert.equal(report.routing.executionVenue.datasetHash, hash(validateDerivativeData(data(base), config(payoff))));
  });

  test(`${payoff}: short funding receipts and negative rates reverse direction`, () => {
    for (const target of ['2', '-2']) for (const rate of ['10000', '-10000']) {
      const dataset = data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['funding', 5, 100, { ratePpm: rate }]]);
      const report = replay(config(payoff), dataset, [[0, target], [5, null]]);
      const amount = payoff === 'linear' ? 2n : 200n;
      assert.equal(BigInt(report.performance.funding), -BigInt(target) / 2n * (BigInt(rate) / 10000n) * amount);
    }
  });

  test(`${payoff}: expiry closes at the explicit settlement price without quote liquidity`, () => {
    const c = config(payoff); c.contract = { kind: 'future', payoff, contractValue: '1', settlementScale: c.contract.settlementScale, expiryTime: '3' };
    const dataset = data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['settlement', 3, 125]]);
    const report = replay(c, dataset, [[0, '-2'], [3, '4']]);
    assert.equal(report.performance.netPnl, payoff === 'linear' ? '-50' : '-4000');
    assert.equal(report.terminal.settled, true); assert.equal(report.terminal.ledger.quantity, '0');
    assert.equal(report.fills.at(-1).reason, 'settlement');
    assert.equal(report.orders.at(-1).status, 'rejected-expired');
  });
}

test('partial liquidity, no same-time fills, separate cancellation latency, and no future-event draining', () => {
  const dataset = data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100, { askLots: '1' }], ['quote', 2, 100, { askLots: '1' }], ['quote', 3, 100], ['quote', 4, 100]]);
  const report = replay(config('linear', { cancelLatencyMs: '2' }), dataset, [[0, '5'], [1, '0'], [2, null], [3, '0']]);
  assert.deepEqual(report.fills.map(f => [f.time, f.quantity]), [['1', '1'], ['2', '1']]);
  assert.equal(report.terminal.ledger.quantity, '2');
  assert.equal(report.orders[0].order.cancelled, '3');
  assert.equal(report.orders[0].order.accepted, '5');
  assert.equal(report.orders[1].status, 'working');
  assert.equal(report.terminal.time, '3');
});

test('risk checks reject leverage at admission and recheck a working order at execution', () => {
  const dataset = data([['mark', 0, 100], ['quote', 0, 100], ['mark', 1, 10], ['quote', 1, 100]]);
  const report = replay(config('linear', { initialCash: '100' }), dataset, [[0, '10'], [1, '101']]);
  assert.equal(report.fills.length, 0);
  assert.deepEqual(report.orders.map(o => o.status), ['rejected-margin-at-fill', 'rejected-position-cap']);
  const rejected = replay(config('linear', { initialCash: '99' }), data([['mark', 0, 100], ['quote', 0, 100]]), [[0, '10']]);
  assert.equal(rejected.orders[0].status, 'rejected-margin');
});

test('mark-based liquidation preserves negative collateral, charges fees and halts new risk', () => {
  const dataset = data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['mark', 2, 80], ['quote', 2, 100]]);
  const report = replay(config('linear', { initialCash: '110', feeBps: '10', liquidationFeeBps: '100' }), dataset, [[0, '10'], [2, '1']]);
  assert.equal(report.performance.liquidations, 1);
  assert.equal(report.fills.at(-1).price, '80', 'Liquidation uses mark, not the unchanged last trade');
  assert.equal(report.performance.fees, '10');
  assert.equal(report.terminal.ledger.cash, '-100');
  assert.equal(report.terminal.deficit, '100');
  assert.equal(report.terminal.bankrupt, true);
  assert.equal(report.orders.at(-1).status, 'rejected-halted');
  assert.equal(report.performance.netPnl, '-210');
});

test('funding can cause liquidation and applies once even with idempotent redelivery', () => {
  const dataset = data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['funding', 5, 100, { ratePpm: '60000' }]]);
  dataset.events.push(structuredClone(dataset.events.at(-1)));
  const report = replay(config('linear', { initialCash: '100' }), dataset, [[0, '10'], [5, null]]);
  assert.equal(report.performance.funding, '-60');
  assert.equal(report.performance.liquidations, 1);
  assert.equal(report.terminal.ledger.cash, '40');
});

test('missing funding, altered duplicates, crossed quotes, stale marks and coverage gaps fail closed', () => {
  const c = config(), dataset = data(base);
  assert.throws(() => validateDerivativeData({ ...dataset, events: dataset.events.filter(e => e.type !== 'funding') }, c), { code: 'MISSING_FUNDING' });
  assert.throws(() => validateDerivativeData({ ...dataset, events: [...dataset.events, { ...dataset.events[0], price: '101' }] }, c), { code: 'EVENT_ID_COLLISION' });
  assert.throws(() => validateDerivativeData(data([['quote', 0, 100, { ask: '99' }]]), c), { code: 'DERIVATIVE_QUOTE' });
  const stale = replay(config('linear', { maxMarkAgeMs: '1' }), data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100]], 3), [[0, '1'], [3, null]]);
  assert.equal(stale.status, 'invalid-data-quality'); assert.equal(stale.performance.netPnl, null);
  const venue = new DerivativeExecutionVenue({ id: 'coverage', config: c, data: data([['mark', 0, 100]]) });
  assert.throws(() => venue.advanceTo('1'), { code: 'DATA_COVERAGE' });
  assert.equal(venue.report().status, 'invalid-data-quality');
  assert.throws(() => venue.advanceTo('0'), { code: 'INVALID_REPLAY' });
});

test('decision-time valuation gaps remain invalid after a fresh mark restores equity', () => {
  const dataset = data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['mark', 4, 100]]);
  for (const target of ['1', '-1', '0']) {
    const report = replay(config('linear', { maxMarkAgeMs: '1' }), dataset, [[0, target], [3, null], [4, null]]);
    assert.equal(report.terminal.equity, '10000', 'Terminal valuation recovers');
    assert.equal(report.status, target === '0' ? 'valid-under-declared-model' : 'invalid-data-quality');
    assert.equal(report.performance.netPnl, target === '0' ? '0' : null);
    assert.equal(report.performance.maxDrawdown, target === '0' ? '0' : null);
    assert.deepEqual(report.dataQuality.issues.map(issue => issue.code), target === '0' ? [] : ['STALE_MARK_HISTORY']);
    const gap = report.valuations.filter(row => row.time === '3');
    assert.equal(gap.length, 1);
    assert.equal(gap[0].eventId, null, 'Clock valuations have no market event identity');
    assert.equal(gap[0].equity, target === '0' ? '10000' : null);
    assert.equal(report.valuations.filter(row => row.time === '4').length, 1, 'Decision and finish do not duplicate the market valuation');
  }
});

test('inverse rounding and contract multiplier use settlement minor units', () => {
  const c = config('inverse'); c.contract.contractValue = '3';
  const dataset = data([['mark', 0, 101], ['quote', 0, 101], ['quote', 1, 101], ['mark', 2, 103], ['quote', 2, 103], ['quote', 3, 103]]);
  for (const target of ['1', '-1']) {
    const report = replay(c, dataset, [[0, target], [2, '0'], [3, null]]);
    // +/- 3,000,000 * (1/101 - 1/103) = +/- 576.756..., floor in both directions.
    assert.equal(report.performance.netPnl, target === '1' ? '576' : '-577');
  }
});

test('randomized linear and inverse round trips agree with an independent rational oracle', () => {
  let seed = 9231;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const payoff of ['linear', 'inverse']) for (let i = 0; i < 30; i++) {
    const entry = 90 + random() % 20, exit = 90 + random() % 20, quantity = (random() % 4 + 1) * (random() % 2 ? 1 : -1);
    const c = config(payoff, { initialCash: '100000', feeBps: '7' });
    const dataset = data([['mark', 0, entry], ['quote', 0, entry], ['quote', 1, entry], ['mark', 2, exit], ['quote', 2, exit], ['quote', 3, exit]]);
    const report = replay(c, dataset, [[0, String(quantity)], [2, '0'], [3, null]]);
    const q = BigInt(quantity), a = BigInt(entry), b = BigInt(exit);
    const numerator = payoff === 'linear' ? q * (b - a) : q * 1000000n * (b - a), denominator = payoff === 'linear' ? 1n : a * b;
    const realized = numerator / denominator - (numerator < 0n && numerator % denominator !== 0n ? 1n : 0n);
    const magnitude = q < 0n ? -q : q;
    const fees = [a, b].reduce((sum, price) => {
      const n = payoff === 'linear' ? magnitude * price * 7n : magnitude * 1000000n * 7n, d = payoff === 'linear' ? 10000n : price * 10000n;
      return sum + n / d + (n % d ? 1n : 0n);
    }, 0n);
    assert.equal(BigInt(report.performance.netPnl), realized - fees);
    assert.equal(report.terminal.ledger.quantity, '0');
  }
});

test('signed signal caps preserve canonical zero and execution prefixes cannot see future data', () => {
  const context = { history: [{}] };
  assert.equal(targetPosition('-20', { maxPositionLots: '3' })(context), '-3');
  assert.equal(targetPosition('-20', { maxPositionLots: '0' })(context), '0');
  assert.throws(() => targetPosition('-0'), { code: 'INVALID_INTEGER' });
  const prefix = [['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100]];
  const short = replay(config(), data(prefix, 2), [[0, '-2'], [2, null]]);
  const extended = replay(config(), data([...prefix, ['mark', 3, 10000], ['quote', 3, 10000]], 4), [[0, '-2'], [2, null]]);
  assert.deepEqual(short.fills, extended.fills);
  assert.deepEqual(short.terminal, extended.terminal);
  assert.equal(short.traceHash, extended.traceHash);
});

test('inverse adverse marks liquidate in coin and fees use reciprocal settlement notional', () => {
  const dataset = data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['mark', 2, 80]]);
  const report = replay(config('inverse', { initialCash: '1500', feeBps: '10' }), dataset, [[0, '1'], [2, null]]);
  assert.equal(report.performance.realizedPnl, '-2500');
  assert.equal(report.performance.fees, '23'); // ceil(10000 * .001) + ceil(12500 * .001)
  assert.equal(report.terminal.ledger.cash, '-1023');
  assert.equal(report.performance.liquidations, 1);
});

test('real derivative studies queue all baselines, preserve fold artifacts and consume final holdout once', { timeout: 60000 }, () => {
  const parent = resolve('output'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'e2e-derivatives-'));
  try {
    for (const payoff of ['linear', 'inverse']) for (const kind of ['future', 'perpetual']) {
      const registry = join(root, `${payoff}-${kind}`);
      const args = ['examples/derivatives.mjs', registry, payoff, kind, '--final'];
      const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 });
      assert.ifError(run.error); assert.equal(run.status, 0, run.stderr + run.stdout);
      const result = JSON.parse(run.stdout);
      assert.equal(result.trials.length, 3);
      assert.ok(result.trials.every(trial => trial.status === 'completed' && trial.result.folds.length === 2));
      assert.equal(result.final.status, 'valid-under-declared-model');
      const records = listExperiments(registry);
      assert.equal(records.length, 4);
      for (const record of records) verifyExperimentArtifacts(registry, record.key);
      const repeat = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 });
      assert.notEqual(repeat.status, 0); assert.match(repeat.stderr, /FINAL_TEST_REUSE|already been released/);
      assert.equal(listExperiments(registry).length, 4);
    }
  } finally {
    assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true });
  }
});
