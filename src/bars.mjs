import { nat, requireThat } from './core.mjs';

const fields = ['openTime', 'closeTime', 'availableAt', 'open', 'high', 'low', 'close', 'volumeLots'];
const positive = value => nat(value, 'positive bar value', true);
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

/** Validate complete, fixed-width, gap-free bars before processing any orders. */
export function validateBars(input, instrument) {
  requireThat(Array.isArray(input) && input.length >= 2, 'BAR_DATA', 'At least two completed bars are required');
  const tick = positive(instrument.priceTick);
  let previous = null, interval = null;
  return Object.freeze(input.map((bar, index) => {
    requireThat(bar && typeof bar === 'object' && !Array.isArray(bar) && Object.getPrototypeOf(bar) === Object.prototype && Reflect.ownKeys(bar).length === fields.length && fields.every(key => Object.hasOwn(bar, key)) && Object.values(Object.getOwnPropertyDescriptors(bar)).every(descriptor => descriptor.enumerable && Object.hasOwn(descriptor, 'value')), 'BAR_SCHEMA', `Bar ${index}: require plain data objects with exactly the supported fields`);
    const v = Object.fromEntries(fields.map(key => [key, nat(bar[key], `bar[${index}].${key}`, ['open', 'high', 'low', 'close'].includes(key))]));
    requireThat(v.closeTime >= v.openTime && v.availableAt === v.closeTime + 1n, 'BAR_TIME', 'Bars become available only after their inclusive close timestamp');
    const width = v.availableAt - v.openTime;
    requireThat(width > 1n && (interval === null || interval === width), 'BAR_INTERVAL', 'Bar intervals must be equal and exceed one millisecond');
    requireThat(previous === null || previous === v.openTime, 'BAR_GAP', 'Bars must be contiguous, unique and increasing; gaps must be resolved explicitly');
    requireThat(v.low <= v.open && v.low <= v.close && v.high >= v.open && v.high >= v.close && v.low <= v.high, 'BAR_OHLC', 'OHLC extrema do not contain open/close');
    for (const key of ['open', 'high', 'low', 'close']) requireThat(v[key] % tick === 0n, 'PRICE_TICK', `Bar ${key} is off tick`);
    interval = width; previous = v.availableAt;
    return freeze(Object.fromEntries(fields.map(key => [key, String(v[key])])));
  }));
}
