import { canonicalExperimentJson, claimExperiment, experimentContext, verifyExperiment } from './experiments.mjs';

const [root, key, token, supervisor, generation, deadline, limits] = process.argv.slice(2);
// The parent records the worker PID before granting permission to execute.
// Losing the parent before that grant cannot leave an unrecorded live worker.
await new Promise(resolve => {
  process.once('disconnect', () => process.exit(75));
  process.once('message', message => { if (message?.start) resolve(); else process.exit(75); });
});
const checkDeadline = () => {
  if (Date.now() >= Number(deadline)) throw Object.assign(new Error('Worker execution deadline exceeded'), { code: 'WORKER_TIMEOUT' });
};
const owned = claimExperiment(root, key, token, Number(supervisor), Number(generation));
if (!owned) process.exit(75);
const send = (message, code) => process.send(message, error => process.exit(error ? 1 : code));
try {
  checkDeadline();
  verifyExperiment(owned.manifest);
  const worker = await import(owned.manifest.workerModule);
  const work = worker.default ?? worker.run;
  if (typeof work !== 'function') throw Object.assign(new Error('Worker module must export default or run as a function'), { code: 'WORKER_EXPORT' });
  const outputLimits = JSON.parse(limits);
  const context = experimentContext({ ...owned, ...outputLimits });
  context.heartbeat();
  const heartbeat = setInterval(context.heartbeat, 1000);
  heartbeat.unref();
  const result = await work(owned.manifest.configuration, context);
  verifyExperiment(owned.manifest);
  checkDeadline();
  // The supervisor publishes success after output streams close and quotas are
  // checked, so excessive late log output cannot race a completed record.
  // Validate before IPC: JSON serialization would otherwise silently coerce NaN.
  const resultJson = canonicalExperimentJson(result);
  if (outputLimits.maxResultBytes !== null && outputLimits.maxResultBytes !== undefined && Buffer.byteLength(resultJson) > outputLimits.maxResultBytes) throw Object.assign(new Error(`Worker result exceeded ${outputLimits.maxResultBytes} bytes`), { code: 'RESULT_LIMIT' });
  send({ success: true, result }, 0);
} catch (error) {
  send({ success: false, error: { code: String(error?.code || 'WORKER_ERROR'), message: String(error?.message ?? error) } }, 1);
}
