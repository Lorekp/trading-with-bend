import { bendRuntime } from './bend-runtime.mjs';
import { nat, requireThat } from './core.mjs';

const roles = { train: 'Train', select: 'Select', final: 'Final' };
const partitions = { train: 'Training', validation: 'Validation', final: 'Holdout' };
export function canReadPartition(role, partition) {
  requireThat(Object.hasOwn(roles, role) && Object.hasOwn(partitions, partition), 'EVALUATION_ROLE', 'Unknown role or partition');
  return bendRuntime().policy.can_read({ $: roles[role] }, { $: partitions[partition] });
}
export function cappedLots(requested, capitalLimit, positionLimit) {
  return String(bendRuntime().policy.capped_lots(nat(requested, 'requested'), nat(capitalLimit, 'capitalLimit'), nat(positionLimit, 'positionLimit')));
}
export function affordableLots(cash, reservedCash, price, fee) {
  const c = nat(cash, 'cash'), r = nat(reservedCash, 'reservedCash');
  const p = nat(price, 'price', true), f = nat(fee, 'fee');
  requireThat(r <= c, 'RESERVATION_BREACH', 'Reserved cash exceeds cash');
  // BigInt division has explicit floor rounding toward zero for these naturals.
  return String((c - r) / (p + f));
}
export function trainingAllowed({ observationTime, labelAvailableAt, cutoff }) {
  return bendRuntime().policy.training_allowed(nat(observationTime, 'observationTime'), nat(labelAvailableAt, 'labelAvailableAt'), nat(cutoff, 'cutoff'));
}
export function modelReady({ labelAvailableAt, trainingStartedAt, trainingCompletedAt, deployedAt, decisionTime }) {
  return bendRuntime().policy.ready_chain(nat(labelAvailableAt, 'labelAvailableAt'), nat(trainingStartedAt, 'trainingStartedAt'), nat(trainingCompletedAt, 'trainingCompletedAt'), nat(deployedAt, 'deployedAt'), nat(decisionTime, 'decisionTime'));
}
export function barExecutionAllowed({ availableAt, openTime, executionTime }) {
  return bendRuntime().policy.bar_execution_allowed(nat(availableAt, 'availableAt'), nat(openTime, 'openTime'), nat(executionTime, 'executionTime'));
}
