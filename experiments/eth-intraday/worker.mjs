import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DerivativeExecutionVenue, InformationSource, evaluateStudy, hash,
  sampleEquity, validateDerivativeData, walkForwardSplits,
} from '../../src/index.mjs';
import { requireThat } from '../../src/core.mjs';

const magnitude = value => value < 0n ? -value : value;

/** Signal intent is separate from observed fills; exits persist through cancellation. */
export function intradaySignal(parameters, endTime) {
  const { family, lookbackMinutes, thresholdBps, targetLots, maxHoldingMinutes, cooldownMinutes } = parameters;
  requireThat(['continuation', 'reversal', 'cash', 'hold', 'short'].includes(family), 'STUDY_SIGNAL', 'Unknown signal family');
  requireThat([lookbackMinutes, maxHoldingMinutes, cooldownMinutes].every(value => Number.isSafeInteger(value) && value > 0)
    && Number.isSafeInteger(thresholdBps) && thresholdBps >= 0 && /^[1-9][0-9]*$/.test(targetLots), 'STUDY_SIGNAL', 'Invalid bounded signal parameters');
  const lots = BigInt(targetLots), terminalExit = BigInt(endTime) - 300000n;
  let entryTime = null, pendingSince = null, exiting = false, cooldownUntil = null, intent = '0';
  const strategy = ({ history, time, ledger, orders }) => {
    const now = BigInt(time), quantity = BigInt(ledger.quantity);
    if (family === 'cash' || now >= terminalExit) return '0';
    if (family === 'hold' || family === 'short') return String(family === 'hold' ? lots : -lots);
    if (quantity !== 0n && entryTime === null) entryTime = now;
    if (exiting) {
      if (quantity === 0n && orders.length === 0) {
        exiting = false; entryTime = null; pendingSince = null; intent = '0';
        cooldownUntil = now + BigInt(cooldownMinutes) * 60000n;
      }
      return '0';
    }
    if (history.length < lookbackMinutes + 1) return null;
    const previous = BigInt(history.at(-lookbackMinutes - 1).close), latest = BigInt(history.at(-1).close);
    const change = latest - previous;
    const direction = magnitude(change) * 10000n <= previous * BigInt(thresholdBps) ? 0n : change > 0n ? 1n : -1n;
    const desired = family === 'reversal' ? -direction : direction;
    if (quantity !== 0n) {
      if (now - entryTime >= BigInt(maxHoldingMinutes) * 60000n || desired === 0n || (desired > 0n) !== (quantity > 0n)) {
        exiting = true; return '0';
      }
      return intent;
    }
    if (orders.length) {
      if (desired === 0n || (desired > 0n) !== (BigInt(intent) > 0n)
        || now - pendingSince >= BigInt(maxHoldingMinutes) * 60000n) {
        exiting = true; return '0';
      }
      return intent;
    }
    if (cooldownUntil !== null && now < cooldownUntil) return '0';
    intent = String(desired * lots);
    pendingSince = desired === 0n ? null : now;
    return intent;
  };
  strategy.lookback = ['cash', 'hold', 'short'].includes(family) ? 1 : lookbackMinutes + 1;
  return strategy;
}

export default async function run(configuration, context) {
  const { datasetPath, datasetHash, split, protocol, parameters, executionOverrides, researchPlan } = configuration;
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const { datasetHash: declaredHash, ...datasetBody } = dataset;
  requireThat(hash(datasetBody) === declaredHash && declaredHash === datasetHash && dataset.developmentOnly === true && dataset.finalPartition.length === 0,
    'STUDY_DATA', 'Use the frozen development-only dataset without a final partition');
  const config = { ...dataset.config, ...executionOverrides };
  requireThat(BigInt(parameters.targetLots) <= BigInt(config.maxPositionLots), 'STUDY_POSITION', 'Signal target exceeds venue cap');
  const data = validateDerivativeData(dataset.data, config);
  const plan = walkForwardSplits(dataset.samples, split);
  requireThat(plan.final.length === 0, 'STUDY_FINAL', 'This exploratory campaign does not release or carry final rows');
  context.writeArtifact('research-plan.json', researchPlan);
  context.writeArtifact('split-plan.json', plan);
  context.writeArtifact('input-provenance.json', { datasetHash, provenance: dataset.provenance,
    executionIdentity: dataset.executionIdentity, informationIdentity: dataset.informationIdentity, config });
  const study = await evaluateStudy({ samples: dataset.samples, plan, protocol }, ({ fold, evaluation }) => {
    context.reportProgress?.({ phase: 'fold', fold: fold.id, parameters });
    const endTime = evaluation.rows.at(-1).availableAt;
    const start = BigInt(evaluation.rows[0].availableAt) - 120n * 60000n;
    // Every candidate and control uses identical warmup/source windows, regardless of lookback.
    const observations = dataset.observations.filter(row => BigInt(row.availableAt) >= start && BigInt(row.availableAt) <= BigInt(endTime));
    const signal = family => intradaySignal({ ...parameters, family }, endTime);
    return {
      strategy: signal(parameters.family),
      baselines: { cash: signal('cash'), hold: signal('hold'), short: signal('short') },
      metadata: { parameters, signalTiming: 'Completed Binance bars; earliest fill is a later independent OKX proxy event',
        terminalExit: 'Request flat five minutes before fold end; report residual positions without invented fills',
        holdingTime: 'Exit request at horizon measured from first observed exposure; actual fills can lag' },
      createReplay: ({ variant }) => ({
        informationSource: new InformationSource({ id: 'binance-eth-september-development', instrument: config.instrument, observations }),
        executionVenue: new DerivativeExecutionVenue({ id: 'okx-eth-bar-proxy', config, data,
          window: { startTime: observations[0].availableAt, endTime },
          auditDirectory: join(context.outputDirectory, `audit-${fold.id}-${variant}`) }),
      }),
    };
  });
  for (const fold of study.folds) {
    const paired = Object.fromEntries([['candidate', fold.candidate], ...Object.entries(fold.baselines)].map(([name, value]) =>
      [name, sampleEquity(value.report, { startTime: fold.startTime, endTime: fold.endTime, ...protocol })]));
    context.writeArtifact(`equity-${fold.id}.json`, { fold: fold.id, convention: 'Independent reset account; exact regular equity, aligned across variants', series: paired });
  }
  context.writeArtifact('study.json', study);
  return { study, parameters, datasetHash, evidence: 'Exploratory September bar execution proxy; no held-out confirmation or calibrated fill claim' };
}
