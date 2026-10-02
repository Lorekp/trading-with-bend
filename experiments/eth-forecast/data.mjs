import { computeFeatures, hash, sequenceSamples, validateBars } from '../../src/index.mjs';

const instrument = { symbol: 'ETHUSDT', currency: 'USDT', priceTick: '10', lotSize: '0.001' };
const schema = [
  ...[1, 5, 15].map(lag => ({ name: `logReturn${lag}`, source: `logReturn${lag}`, kind: 'value', unit: 'log-ratio' })),
  { name: 'logVolume', source: 'logVolume', kind: 'value', unit: 'log1p-ETH' },
  { name: 'range', source: 'range', kind: 'value', unit: 'ratio' },
  { name: 'volatility15', source: 'logReturn1', kind: 'std', window: 15, unit: 'log-ratio' },
];

export function ethForecastData(input, venue = 'binance-usdm') {
  const bars = validateBars(input, instrument);
  if (BigInt(bars[0].availableAt) - BigInt(bars[0].openTime) !== 60000n) throw new Error('ETH forecasting requires one-minute bars');
  // A small explicit price adapter. No funding, mark/index, trade-count or
  // order-book proxies are invented from OHLCV.
  const readyBars = bars.slice(15);
  const features = computeFeatures(readyBars.map((bar, offset) => {
    const i = offset + 15;
    return { time: bar.availableAt, availableAt: bar.availableAt, values: {
      ...Object.fromEntries([1, 5, 15].map(lag => [`logReturn${lag}`, Math.log(Number(bar.close) / Number(bars[i - lag].close))])),
      logVolume: Math.log1p(Number(bar.volumeLots) / 1000), range: (Number(bar.high) - Number(bar.low)) / Number(bar.close),
    } };
  }), schema);
  return { ...sequenceSamples({ observations: features.map((feature, i) => ({ feature, price: Number(readyBars[i].close) })),
    schema, instrument: 'ETHUSDT', venue }), dataHash: hash(bars) };
}

/** Deterministic pipeline fixture, not a calibrated market or performance test. */
export function fixtureBars(count = 600, seed = 41) {
  let state = seed >>> 0, price = 3000000;
  return Array.from({ length: count }, (_, i) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const open = price; price = Math.max(10000, price + (state % 41 - 20) * 10);
    return { openTime: String(i * 60000), closeTime: String((i + 1) * 60000 - 1), availableAt: String((i + 1) * 60000),
      open: String(open), close: String(price), high: String(Math.max(open, price) + 100), low: String(Math.min(open, price) - 100),
      volumeLots: String(10000 + state % 100000) };
  });
}
