import { hash, nat, requireThat } from './core.mjs';
import { canReadPartition, modelReady } from './policies.mjs';

export function validateModelArtifact(artifact, schema, decisionTime) {
  requireThat(artifact.featureSchemaHash === hash(schema), 'FEATURE_SCHEMA', 'Feature names, ordering, units or missingness differ from model');
  requireThat(typeof artifact.modelHash === 'string' && /^[0-9a-f]{64}$/.test(artifact.modelHash), 'MODEL_LINEAGE', 'Model content hash is required');
  requireThat(typeof artifact.preprocessingHash === 'string' && /^[0-9a-f]{64}$/.test(artifact.preprocessingHash), 'MODEL_LINEAGE', 'Preprocessing content hash is required');
  requireThat(artifact.fold === artifact.preprocessingFold, 'FOLD_MISMATCH', 'Preprocessing belongs to another fold');
  requireThat(typeof artifact.fold === 'string' && artifact.fold.length > 0, 'MODEL_LINEAGE', 'Fold is required');
  const label = nat(artifact.lastLabelAvailableAt, 'lastLabelAvailableAt');
  const start = nat(artifact.trainingStartedAt, 'trainingStartedAt');
  const complete = nat(artifact.trainingCompletedAt, 'trainingCompletedAt');
  const deploy = nat(artifact.deployedAt, 'deployedAt');
  requireThat(modelReady({ labelAvailableAt: String(label), trainingStartedAt: String(start), trainingCompletedAt: String(complete), deployedAt: String(deploy), decisionTime }), 'MODEL_NOT_AVAILABLE', 'Labels, training or deployment are not available at decision time');
  return true;
}

export class EvaluationSession {
  #protocol; #finalUsed = false;
  constructor(protocol) {
    requireThat(protocol && typeof protocol.id === 'string' && protocol.id.length > 0 && typeof protocol.strategyHash === 'string' && /^[0-9a-f]{64}$/.test(protocol.strategyHash), 'EVALUATION_PROTOCOL', 'Fix protocol ID and strategy content hash before evaluation');
    this.#protocol = structuredClone(protocol);
  }
  authorize(role, partition, strategyHash) {
    requireThat(['train', 'select', 'final'].includes(role) && ['train', 'validation', 'final'].includes(partition), 'EVALUATION_ROLE', 'Unknown role or partition');
    requireThat(strategyHash === this.#protocol.strategyHash, 'STRATEGY_CHANGED', 'Strategy differs from fixed evaluation protocol');
    const allowed = canReadPartition(role, partition);
    requireThat(allowed, 'FINAL_TEST_ACCESS', 'Requested partition is not permitted for this role');
    if (role === 'final') { requireThat(!this.#finalUsed, 'FINAL_TEST_REUSE', 'Final evaluation already consumed in this session'); this.#finalUsed = true; }
    return structuredClone(this.#protocol);
  }
}
