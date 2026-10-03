import { Session } from 'node:inspector';
import benchmarkWorker from '../speed/worker.mjs';

// Profiling attempts retain complete audits but never enter timing inference.
export default async function(configuration, context) {
  const session = new Session();
  session.connect();
  const post = method => new Promise((resolve, reject) => session.post(method, (error, result) => error ? reject(error) : resolve(result)));
  try {
    await post('Profiler.enable');
    await post('Profiler.start');
    const result = await benchmarkWorker(configuration, context);
    const { profile } = await post('Profiler.stop');
    context.writeArtifact('profile.cpuprofile', profile);
    const samples = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0);
    const locations = new Map();
    for (const node of profile.nodes) {
      if (!node.hitCount) continue;
      const { functionName, url, lineNumber } = node.callFrame;
      const key = JSON.stringify([functionName, url, lineNumber]);
      const location = locations.get(key) ?? { function: functionName || '(anonymous)', file: url, line: lineNumber + 1, hits: 0 };
      location.hits += node.hitCount;
      locations.set(key, location);
    }
    const hotspots = [...locations.values()].sort((a, b) => b.hits - a.hits).slice(0, 20)
      .map(({ hits, ...location }) => ({ ...location, selfPercent: 100 * hits / samples }));
    return { ...result, eligibleForTimingInference: false, hotspots };
  } finally { session.disconnect(); }
}
