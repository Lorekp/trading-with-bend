import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DerivativeExecutionVenue, validateDerivativeData, InformationSource, runStrategy, targetPosition, listExperiments, verifyExperimentArtifacts, hash } from '../../src/index.mjs';
import { loadProcessedDerivativeData } from '../../src/executable-data.mjs';
import { prepareMarketData } from '../../src/market-data.mjs';
import { readReplayAudit } from '../../src/recording.mjs';

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
const base = [['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['mark', 2, 110], ['quote', 2, 110], ['quote', 3, 110], ['funding', 5, 110, { rate: { numerator: '1', denominator: '100' } }], ['mark', 6, 110], ['quote', 6, 110], ['quote', 7, 110]];

test('funding preserves sub-ppm fractions and rounds only the final settlement transfer', () => {
  for (const numerator of ['23', '-23']) for (const target of ['100', '-100']) {
    const c = config('linear', { initialCash: '1000000000' });
    const dataset = data([['mark', 0, 1000000], ['quote', 0, 1000000], ['quote', 1, 1000000],
      ['funding', 5, 1000000, { rate: { numerator, denominator: '25000000' } }]]);
    const report = replay(c, dataset, [[0, target], [5, null]]);
    assert.equal(report.performance.funding, String(-BigInt(target) / 100n * BigInt(numerator) * 4n));
  }
  for (const rate of [{ numerator: '1', denominator: '0' }, { numerator: '-0', denominator: '1' }, { numerator: '2', denominator: '1' }]) {
    assert.throws(() => validateDerivativeData(data([['funding', 5, 100, { rate }]]), config()), { code: 'DERIVATIVE_FUNDING' });
  }
  const c = config(); c.contract.fundingTimestampToleranceMs = '2';
  const delayed = data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['funding', 6, 100, { rate: { numerator: '1', denominator: '100' } }]]);
  const report = replay(c, delayed, [[0, '2'], [5, null], [6, null]]);
  assert.equal(report.postings.find(posting => posting.type === 'funding').time, '6', 'Timestamp tolerance must not move funding earlier');
  assert.throws(() => validateDerivativeData(delayed, config()), { code: 'DERIVATIVE_FUNDING' });
  const duplicate = structuredClone(delayed.events.at(-1)); duplicate.id = 'duplicate-slot'; duplicate.sequence = '5'; duplicate.time = duplicate.sourceTime = '7';
  assert.throws(() => validateDerivativeData({ ...delayed, endTime: '7', events: [...delayed.events, duplicate] }, c), { code: 'DERIVATIVE_FUNDING' });
});

test('admitted immutable datasets are reusable and windows seed market state without replaying the prefix', () => {
  const c = config(), input = data(base), admitted = validateDerivativeData(input, c);
  assert.equal(validateDerivativeData(admitted, { ...c, initialCash: '20000' }), admitted);
  input.events[0].price = '999';
  assert.equal(admitted.events[0].price, '100');
  assert.throws(() => { admitted.events[0].price = '999'; }, TypeError);
  assert.throws(() => validateDerivativeData(admitted, { ...c, contract: { ...c.contract, fundingOffsetMs: '6' } }), { code: 'UNIT_MISMATCH' });
  const prefix = new DerivativeExecutionVenue({ id: 'prefix', config: c, data: admitted });
  const window = new DerivativeExecutionVenue({ id: 'window', config: c, data: admitted, window: { startTime: '4', endTime: '7' } });
  for (const venue of [prefix, window]) {
    venue.advanceTo('4'); venue.setTarget('2', '4'); venue.advanceTo('7'); venue.finish('7');
  }
  const whole = prefix.report(), selected = window.report();
  assert.deepEqual(selected.terminal, whole.terminal);
  assert.deepEqual(selected.fills, whole.fills);
  assert.deepEqual(selected.postings, whole.postings);
  assert.deepEqual(selected.valuations, whole.valuations.filter(row => BigInt(row.time) >= 4n));
  assert.ok(selected.valuations.every(row => BigInt(row.time) >= 4n));
  assert.equal(selected.manifest.datasetHash, whole.manifest.datasetHash);
  const invalid = new DerivativeExecutionVenue({ id: 'clip', config: c, data: admitted, window: { startTime: '4', endTime: '6' } });
  assert.throws(() => invalid.advanceTo('7'), { code: 'DATA_COVERAGE' });
  const expiry = { ...c, contract: { kind: 'future', payoff: 'linear', contractValue: '1', settlementScale: '1', expiryTime: '3' } };
  const settled = new DerivativeExecutionVenue({ id: 'settled', config: expiry, data: data([['mark', 0, 100], ['quote', 0, 100], ['settlement', 3, 125]], 7), window: { startTime: '4', endTime: '7' } });
  settled.advanceTo('4'); settled.setTarget('1', '4'); settled.finish('4');
  assert.equal(settled.report().terminal.settled, true);
  assert.equal(settled.report().orders[0].status, 'rejected-expired');
});

test('processed derivative bridge verifies shards, normalizes units and makes liquidity assumptions explicit', async () => {
  const parent = resolve('output'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'e2e-executable-'));
  try {
    const rawDirectory = join(root, 'raw'); mkdirSync(rawDirectory);
    const canonical = { symbol: 'ETH/USDT', currency: 'USDT-micro', lotSize: '0.001', priceTick: '10' };
    const c = config('linear', { instrument: canonical, initialCash: '1000000000' });
    const observation = (time, row) => ({ time: String(time), availableAt: String(time), data: row });
    const series = {
      markPrice: [observation(0, { close: '100000000001' }), observation(6, { close: '110000000000' })],
      funding: [observation(5, { rate: { numerator: '23', denominator: '25000000' }, rateRole: 'realized', settlementTime: '5', publishedAt: '5' })],
      bookTicker: [0, 1, 6].map(time => observation(time, { eventId: String(time), bid: '1000000', ask: '1000000', bidSizeLots: '1000', askSizeLots: '1000' })),
      bars: [0, 1, 6].map(time => observation(time, { close: '1000000', volumeLots: '1000' })),
    };
    for (const [kind, records] of Object.entries(series)) {
      const manifest = { venue: 'okx', kind, rawDirectory, instrument: canonical, sourceMarket: 'linear USDT perpetual',
        ...(kind === 'funding' ? { funding: { source: 'okx-history', rateRole: 'realized', publicationTime: 'settlement-assumption' } } : {}),
        window: { startTime: '0', endTime: '7' }, expectedStepMs: null };
      await prepareMarketData({ source: { manifest, async *records() { yield* records; } }, outputDirectory: join(root, kind) });
    }
    const options = { config: c, quoteManifestPath: join(root, 'bookTicker', 'manifest.json'), markManifestPath: join(root, 'markPrice', 'manifest.json'),
      fundingManifestPath: join(root, 'funding', 'manifest.json'), startTime: '0', endTime: '6', markRounding: 'floor', liquidity: { model: 'displayed-size', participationBps: '1000' } };
    await assert.rejects(loadProcessedDerivativeData({ ...options, markRounding: 'exact' }), { code: 'DATA_PRECISION' });
    const loaded = await loadProcessedDerivativeData(options);
    assert.equal(loaded.data.events.find(event => event.type === 'quote').askLots, '100');
    assert.equal(loaded.data.events[0].price, '1000000');
    assert.deepEqual(loaded.data.events.find(event => event.type === 'funding').rate, { numerator: '23', denominator: '25000000' });
    for (const [name, role, time, availableAt, expected] of [
      ['archive', 'archive', '5', '5', 'FUNDING_CONTRACT'],
      ['prediction', 'predicted', '4', '4', 'FUNDING_CONTRACT'],
      ['late-realized', 'realized', '6', '6', 'FUNDING_TIMING'],
      ['delayed-realized', 'realized', '5', '6', 'NON_EXECUTABLE_QUOTE'],
    ]) {
      const manifest = { venue: 'okx', kind: 'funding', rawDirectory, instrument: canonical, sourceMarket: 'linear USDT perpetual',
        funding: { rateRole: role }, window: { startTime: '0', endTime: '7' }, expectedStepMs: null };
      const record = { time, availableAt, data: { ...series.funding[0].data, rateRole: role, publishedAt: time } };
      await prepareMarketData({ source: { manifest, async *records() { yield record; } }, outputDirectory: join(root, name) });
      await assert.rejects(loadProcessedDerivativeData({ ...options, fundingManifestPath: join(root, name, 'manifest.json') }), { code: expected });
    }
    const venue = new DerivativeExecutionVenue({ id: loaded.identity, config: c, data: loaded.data });
    venue.advanceTo('0'); venue.setTarget('100', '0'); venue.advanceTo('6'); venue.finish('6');
    assert.equal(venue.report().performance.funding, '-92');
    assert.ok(loaded.provenance.assumptions.some(value => value.includes('Queue position')));
    const proxy = await loadProcessedDerivativeData({ ...options, quoteManifestPath: join(root, 'bars', 'manifest.json'), liquidity: { model: 'bar-volume', participationBps: '100', halfSpreadTicks: '2' } });
    const quote = proxy.data.events.find(event => event.type === 'quote');
    assert.deepEqual([quote.bid, quote.ask, quote.askLots], ['999980', '1000020', '10']);
    await assert.rejects(loadProcessedDerivativeData({ ...options, maxEvents: 2 }), { code: 'DATA_SIZE' });
    await assert.rejects(loadProcessedDerivativeData({ ...options, startTime: '5' }), { code: 'STALE_MARK' });
    await assert.rejects(loadProcessedDerivativeData({ ...options, config: { ...c, contract: { ...c.contract, fundingOffsetMs: '4' } } }), { code: 'DERIVATIVE_FUNDING' });
  } finally { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); }
});

test('disk derivative audit exactly matches memory through partial fills, cancellation, funding and report hydration', () => {
  const parent = resolve('output'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'e2e-derivative-audit-'));
  try {
    const rows = [['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100, { askLots: '1' }],
      ['quote', 2, 100, { askLots: '1' }], ['quote', 3, 100], ['mark', 4, 110], ['quote', 4, 110],
      ['funding', 5, 110, { rate: { numerator: '23', denominator: '25000000' } }], ['quote', 6, 110], ['quote', 7, 110]];
    for (const payoff of ['linear', 'inverse']) {
      const c = config(payoff, { cancelLatencyMs: '2' }), admitted = validateDerivativeData(data(rows), c);
      const venues = [undefined, join(root, payoff)].map(auditDirectory => new DerivativeExecutionVenue({ id: 'equivalent', config: c, data: admitted, ...(auditDirectory ? { auditDirectory } : {}) }));
      for (const venue of venues) {
        for (const [time, target] of [['0', '5'], ['1', '0'], ['3', '2'], ['5', '0'], ['7', null]]) {
          venue.advanceTo(time); if (target !== null) venue.setTarget(target, time);
        }
        venue.finish('7');
      }
      const [memory, disk] = venues, expected = memory.report(), summary = disk.report();
      assert.equal(summary.fills, undefined); assert.equal(summary.orders, undefined);
      assert.equal(summary.traceHash, expected.traceHash);
      assert.deepEqual(summary.performance, expected.performance);
      assert.ok(expected.orders.some(record => record.status === 'cancelled'));
      assert.ok(expected.postings.some(posting => posting.type === 'funding'));
      assert.equal(expected.fills[0].quantity, '1');
      for (const kind of ['fills', 'orders', 'postings', 'valuations']) {
        assert.equal(summary.audit.streams[kind].count, expected[kind].length);
        const records = JSON.parse(JSON.stringify([...readReplayAudit(summary.audit, kind)], (_, value) => typeof value === 'bigint' ? String(value) : value));
        assert.deepEqual(records, expected[kind]);
      }
      const { audit, ...hydrated } = disk.report({ detail: 'full' });
      assert.deepEqual(hydrated, expected);
      hydrated.fills[0].price = '999999'; hydrated.orders.length = 0;
      const { audit: repeatedAudit, ...repeated } = disk.report({ detail: 'full' });
      assert.deepEqual(repeated, expected, 'Mutating a returned report must not change the sealed audit');
      assert.equal(repeatedAudit.checksum, audit.checksum);
    }
  } finally { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); }
});

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
      const dataset = data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['funding', 5, 100, { rate: { numerator: rate, denominator: '1000000' } }]]);
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
  const dataset = data([['mark', 0, 100], ['quote', 0, 100], ['quote', 1, 100], ['funding', 5, 100, { rate: { numerator: '3', denominator: '50' } }]]);
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
      assert.ok(result.trials.every(trial => trial.status === 'completed' && trial.result.study.folds.length === 2));
      assert.equal(result.selection.population.length, 3);
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
