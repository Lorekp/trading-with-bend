// Pure validation and content identity; importing this module needs no Bend build.
import { createHash } from 'node:crypto';

export const MAX_NAT = (1n << 48n) - 1n;
export class BacktestError extends Error {
  constructor(code, message) { super(message); this.name = 'BacktestError'; this.code = code; }
}
export function requireThat(ok, code, message) {
  if (!ok) throw new BacktestError(code, message);
}
export function nat(value, name, positive = false) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'INVALID_INTEGER', `${name} must be a canonical decimal string`);
  const n = BigInt(value);
  requireThat(n <= MAX_NAT && (!positive || n > 0n), 'INTEGER_RANGE', `${name} outside ${positive ? 1 : 0}..2^48-1`);
  return n;
}
export function integer(value, name) {
  requireThat(typeof value === 'string' && /^(0|-?[1-9][0-9]*)$/.test(value), 'INVALID_INTEGER', `${name} must be a canonical signed decimal string`);
  nat(value.startsWith('-') ? value.slice(1) : value, name);
  return BigInt(value);
}
export function checked(n, name) {
  requireThat(n >= 0n && n <= MAX_NAT, 'ARITHMETIC_RANGE', `${name} outside 0..2^48-1`);
  return n;
}
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export function canonical(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');

// Only values recursively frozen here may bypass future recursive traversal.
// Object.isFrozen alone is insufficient: callers can shallow-freeze containers.
const DEEP_FROZEN = new WeakSet();


export function freeze(value) {
  if (value && typeof value === 'object' && !DEEP_FROZEN.has(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value); DEEP_FROZEN.add(value);
  }
  return value;
}
