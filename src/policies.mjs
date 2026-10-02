import Policy from '../build/policy.mjs';
import { nat, requireThat } from './framework.mjs';

const roles = { train: 'Train', select: 'Select', final: 'Final' };
const partitions = { train: 'Training', validation: 'Validation', final: 'Holdout' };
export function canReadPartition(role, partition) {
  requireThat(Object.hasOwn(roles, role) && Object.hasOwn(partitions, partition), 'EVALUATION_ROLE', 'Unknown role or partition');
  return Policy.can_read({ $: roles[role] }, { $: partitions[partition] });
}
export function cappedLots(requested, capitalLimit, positionLimit) {
  return String(Policy.capped_lots(nat(requested, 'requested'), nat(capitalLimit, 'capitalLimit'), nat(positionLimit, 'positionLimit')));
}
export function affordableLots(cash, reservedCash, price, fee) {
  const c = nat(cash, 'cash'), r = nat(reservedCash, 'reservedCash');
  const p = nat(price, 'price', true), f = nat(fee, 'fee');
  requireThat(r <= c, 'RESERVATION_BREACH', 'Reserved cash exceeds cash');
  // BigInt division has explicit floor rounding toward zero for these naturals.
  return String((c - r) / (p + f));
}
export function trainingAllowed({ observationTime, labelAvailableAt, cutoff }) {
  return Policy.training_allowed(nat(observationTime, 'observationTime'), nat(labelAvailableAt, 'labelAvailableAt'), nat(cutoff, 'cutoff'));
}
export function modelReady({ labelAvailableAt, trainingStartedAt, trainingCompletedAt, deployedAt, decisionTime }) {
  return Policy.ready_chain(nat(labelAvailableAt, 'labelAvailableAt'), nat(trainingStartedAt, 'trainingStartedAt'), nat(trainingCompletedAt, 'trainingCompletedAt'), nat(deployedAt, 'deployedAt'), nat(decisionTime, 'decisionTime'));
}
export function barExecutionAllowed({ availableAt, openTime, executionTime }) {
  return Policy.bar_execution_allowed(nat(availableAt, 'availableAt'), nat(openTime, 'openTime'), nat(executionTime, 'executionTime'));
}
