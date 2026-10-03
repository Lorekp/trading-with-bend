import { MAX_NAT, requireThat } from './core.mjs';

/** Parse decimal/scientific literals without passing their coefficient through Number. */
export function exactDecimal(value, name, { signed = false, prefix = 'DATA' } = {}) {
  const match = typeof value === 'string' && value.length <= 64 && /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?(?:0|[1-9][0-9]*)))?$/.exec(value);
  requireThat(match && (signed || match[1] === ''), `${prefix}_DECIMAL`, `${name} must be an exact ${signed ? 'signed' : 'nonnegative'} decimal`);
  const [, sign, integer, fraction = '', exponentText = '0'] = match, exponent = Number(exponentText);
  requireThat(fraction.length <= 18 && Number.isSafeInteger(exponent) && Math.abs(exponent) <= 18,
    `${prefix}_DECIMAL`, `${name} exceeds supported precision/exponent`);
  const power = fraction.length - exponent;
  return { numerator: BigInt(integer + fraction) * (sign === '-' ? -1n : 1n) * (power < 0 ? 10n ** BigInt(-power) : 1n),
    denominator: power > 0 ? 10n ** BigInt(power) : 1n };
}

export function scaledDecimal(value, scale, name, options = {}) {
  const number = exactDecimal(value, name, options), numerator = number.numerator * scale;
  requireThat(numerator % number.denominator === 0n, `${options.prefix ?? 'DATA'}_PRECISION`, `${name} cannot be represented exactly in the declared units`);
  const result = numerator / number.denominator;
  requireThat(result >= -MAX_NAT && result <= MAX_NAT, 'INTEGER_RANGE', `${name} exceeds supported integer range`);
  return result;
}

export const decimalAtMost = (left, right) => left.numerator * right.denominator <= right.numerator * left.denominator;

export function rationalStrings({ numerator, denominator }) {
  let a = numerator < 0n ? -numerator : numerator, b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: String(numerator / a), denominator: String(denominator / a) };
}
