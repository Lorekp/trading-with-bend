import test from 'node:test';
import assert from 'node:assert/strict';
import { intradaySignal } from './worker.mjs';

const parameters = { family: 'continuation', lookbackMinutes: 2, thresholdBps: 10,
  targetLots: '1000', maxHoldingMinutes: 60, cooldownMinutes: 15 };
const context = (minute, prices, quantity = '0', orders = []) => ({ time: String(minute * 60000),
  history: prices.map(close => ({ close: String(close) })), ledger: { quantity }, orders });

test('competing families use only completed history and a common dead band', () => {
  const trend = intradaySignal(parameters, '86400000');
  const reversal = intradaySignal({ ...parameters, family: 'reversal' }, '86400000');
  assert.equal(trend(context(1, [10000, 10100])), null);
  assert.equal(trend(context(2, [10000, 10100, 10200])), '1000');
  assert.equal(reversal(context(2, [10000, 10100, 10200])), '-1000');
  const quiet = intradaySignal(parameters, '86400000');
  assert.equal(quiet(context(2, [10000, 10001, 10005])), '0');
});

test('invalidated entry cancels, waits through a late partial fill, then starts cooldown', () => {
  const signal = intradaySignal(parameters, '86400000');
  assert.equal(signal(context(2, [10000, 10100, 10200])), '1000');
  assert.equal(signal(context(3, [10100, 10200, 9900], '0', [{}])), '0');
  assert.equal(signal(context(4, [9900, 10100, 10200], '200', [{}])), '0');
  assert.equal(signal(context(5, [9900, 10100, 10200])), '0');
  assert.equal(signal(context(19, [9900, 10100, 10200])), '0');
  assert.equal(signal(context(20, [9900, 10100, 10200])), '1000');
});

test('holding limit starts from observed exposure and an aged unfilled intent expires', () => {
  const signal = intradaySignal(parameters, '86400000');
  signal(context(2, [10000, 10100, 10200]));
  assert.equal(signal(context(5, [10000, 10100, 10200], '300', [{}])), '1000');
  assert.equal(signal(context(64, [10000, 10100, 10200], '1000')), '1000');
  assert.equal(signal(context(65, [10000, 10100, 10200], '1000')), '0');
  const pending = intradaySignal(parameters, '86400000');
  pending(context(2, [10000, 10100, 10200]));
  assert.equal(pending(context(62, [10000, 10100, 10200], '0', [{}])), '0');
});
