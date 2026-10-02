import { requireThat } from './core.mjs';

function samples(values) {
  requireThat(Array.isArray(values) && values.length > 0, 'NUMERICAL_INPUT', 'A nonempty numeric array is required');
  for (const value of values) requireThat(typeof value === 'number' && Number.isFinite(value), 'NUMERICAL_INPUT', 'Numerical inputs must be finite');
}
function maxMagnitude(values) {
  let result = 0;
  for (const value of values) result = Math.max(result, Math.abs(value));
  return result;
}
// Neumaier summation retains small terms through cancellation. A nonfinite
// unscaled result tells stableMean to retry in bounded coordinates.
function compensatedSum(values) {
  let sum = 0, correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
    sum = next;
  }
  return sum + correction;
}
function rescale(value, scale, name) {
  const result = value * scale;
  requireThat(Number.isFinite(result), 'NUMERICAL_OVERFLOW', `${name} exceeds the finite floating-point range`);
  requireThat(value === 0 || result !== 0, 'NUMERICAL_UNDERFLOW', `${name} is nonzero but below the representable floating-point range`);
  return result;
}

/** Floating-point mean with compensated summation; constants remain exact. */
export function stableMean(values) {
  samples(values);
  if (values.every(value => value === values[0])) return values[0];
  const direct = compensatedSum(values);
  if (Number.isFinite(direct)) {
    const result = direct / values.length;
    requireThat(direct === 0 || result !== 0, 'NUMERICAL_UNDERFLOW', 'Mean is nonzero but below the representable floating-point range');
    return result;
  }
  const scale = maxMagnitude(values);
  const normalized = values.map(value => value / scale);
  // A term lost before cancellation could determine the entire mean. Reject
  // that unsupported dynamic range rather than manufacture a zero mean.
  requireThat(normalized.every((value, index) => values[index] === 0 || Math.abs(value) >= 2 ** -1022), 'NUMERICAL_UNDERFLOW', 'Input dynamic range loses precision in a nonzero term while computing the mean');
  const total = compensatedSum(normalized);
  if (Math.abs(total) > 1) return rescale(total / values.length, scale, 'Mean');
  const result = rescale(total, scale, 'Mean') / values.length;
  requireThat(total === 0 || result !== 0, 'NUMERICAL_UNDERFLOW', 'Mean is nonzero but below the representable floating-point range');
  return result;
}

/** Compute RMS without squaring values in their original units. */
export function rootMeanSquare(values) {
  samples(values);
  const scale = maxMagnitude(values);
  if (scale === 0) return 0;
  const sumSquares = compensatedSum(values.map(value => (value / scale) ** 2));
  return rescale(Math.sqrt(sumSquares / values.length), scale, 'Root mean square');
}

/** Population moments, translated before normalization to preserve variation
 * near a large common offset. Opposite extreme values use scaled coordinates
 * directly if subtraction would overflow. These are numerical, not exact,
 * research calculations; an unrepresentable nonzero result is an error.
 */
export function populationMoments(values) {
  samples(values);
  const mean = stableMean(values);
  if (values.every(value => value === values[0])) return { mean, standardDeviation: 0 };
  const offsets = values.map(value => value - values[0]);
  const coordinates = offsets.every(Number.isFinite) ? offsets : values;
  const scale = maxMagnitude(coordinates);
  const normalized = coordinates.map(value => value / scale);
  const center = stableMean(normalized);
  const deviation = rootMeanSquare(normalized.map(value => value - center));
  return { mean, standardDeviation: rescale(deviation, scale, 'Standard deviation') };
}
