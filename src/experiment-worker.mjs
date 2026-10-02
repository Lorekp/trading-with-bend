import { claimExperiment, experimentContext, finishExperimentAttempt, verifyExperiment } from './experiments.mjs';

const [root, key, token, supervisor, generation, deadline] = process.argv.slice(2);
const checkDeadline = () => {
  if (Date.now() >= Number(deadline)) throw Object.assign(new Error('Worker execution deadline exceeded'), { code: 'WORKER_TIMEOUT' });
};
const owned = claimExperiment(root, key, token, Number(supervisor), Number(generation));
if (!owned) process.exit(75); // A concurrent runner already claimed this job.
try {
  checkDeadline();
  verifyExperiment(owned.manifest);
  const worker = await import(owned.manifest.workerModule);
  const work = worker.default ?? worker.run;
  if (typeof work !== 'function') throw Object.assign(new Error('Worker module must export default or run as a function'), { code: 'WORKER_EXPORT' });
  const context = experimentContext(owned);
  const result = await work(owned.manifest.configuration, context);
  verifyExperiment(owned.manifest);
  checkDeadline();
  finishExperimentAttempt(owned.path, token, result);
  process.exit(0);
} catch (error) {
  finishExperimentAttempt(owned.path, token, null, error);
  process.exit(1);
}
