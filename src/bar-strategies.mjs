import { checked, hash, nat, requireThat } from './core.mjs';
import { RollingFeatures } from './features.mjs';
import { fitRidge, predictRidge } from './models.mjs';
import { cappedLots } from './policies.mjs';
import { trainingWindow as createTrainingWindow } from './evaluation.mjs';

const size = (value, name, minimum = 1) => {
  requireThat(Number.isSafeInteger(value) && value >= minimum && value <= 1_000_000, 'STRATEGY_PARAMETER', `${name} must be an integer in ${minimum}..1000000`);
  return value;
};
const numeric = (value, name) => {
  requireThat(typeof value === 'number' && Number.isFinite(value), 'STRATEGY_PARAMETER', `${name} must be finite`);
  return value;
};
const stateNat = (value, name) => nat(typeof value === 'bigint' ? String(value) : value, name);
const sum = values => values.reduce((total, value) => total + value, 0n);
const minimum = (a, b) => a < b ? a : b;
const maximum = (a, b) => a > b ? a : b;

function validateContext(context) {
  requireThat(context && context.bar && Array.isArray(context.history) && context.history.length > 0 && context.ledger, 'STRATEGY_CONTEXT', 'Expected completed bar, bounded history and actual ledger');
  const { bar } = context;
  for (const key of ['openTime', 'closeTime', 'availableAt', 'open', 'high', 'low', 'close', 'volumeLots']) nat(bar[key], `bar.${key}`, ['open', 'high', 'low', 'close'].includes(key));
  requireThat(BigInt(bar.openTime) <= BigInt(bar.closeTime) && BigInt(bar.availableAt) === BigInt(bar.closeTime) + 1n, 'STRATEGY_CONTEXT', 'Completed bar availability must be closeTime + 1');
  requireThat(context.history.at(-1).closeTime === bar.closeTime && context.history.at(-1).close === bar.close, 'STRATEGY_CONTEXT', 'History must end with the current completed bar');
  requireThat(nat(context.time, 'decision time') >= BigInt(bar.availableAt), 'STRATEGY_CONTEXT', 'Decision time cannot precede completed bar availability');
  stateNat(context.ledger.cash, 'ledger.cash'); stateNat(context.ledger.quantity, 'ledger.quantity');
  size(context.index, 'index', 0);
}

/** Fresh factory instance per replay. Returns desired total lots; the replay bridge owns orders and fills. */
export function createBarStrategy(spec) {
  requireThat(spec && typeof spec === 'object' && !Array.isArray(spec), 'STRATEGY_PARAMETER', 'A strategy specification is required');
  const supported = ['hold', 'ma-cross', 'volatility-breakout', 'walkforward-ridge'];
  requireThat(supported.includes(spec.type), 'STRATEGY_PARAMETER', `Strategy type must be one of ${supported.join(', ')}`);
  const parameters = {
    hold: [],
    'ma-cross': ['fast', 'slow'],
    'volatility-breakout': ['entryWindow', 'exitWindow', 'atrWindow', 'trendWindow', 'riskBps', 'trailingAtr', 'cooldownBars'],
    'walkforward-ridge': ['featureWindow', 'trainingWindow', 'minTrain', 'retrainEvery', 'alpha', 'entryThreshold', 'exitThreshold', 'trainingTimeMs', 'deploymentDelayMs', 'recordModels'],
  };
  const allowed = ['type', 'quantity', ...parameters[spec.type]];
  requireThat(Reflect.ownKeys(spec).every(key => typeof key === 'string' && allowed.includes(key)), 'STRATEGY_PARAMETER', 'Unknown strategy option; parameters must belong to the selected strategy type');
  requireThat(Object.values(Object.getOwnPropertyDescriptors(spec)).every(descriptor => descriptor.enumerable && Object.hasOwn(descriptor, 'value')), 'STRATEGY_PARAMETER', 'Strategy parameters must be plain data properties');
  spec = structuredClone(spec);
  nat(spec.quantity, 'quantity', true);
  const snapshot = structuredClone(spec), diagnostics = { type: spec.type, specificationHash: hash(snapshot), bars: 0, warmupBars: 0, longTargets: 0, flatTargets: 0, unchangedTargets: 0 };
  const modelArtifacts = [];
  let lookback = 1, decide, lastIndex = -1, lastAvailable = null;

  if (spec.type === 'hold') {
    decide = () => spec.quantity;
  } else if (spec.type === 'ma-cross') {
    const fast = size(spec.fast ?? 5, 'fast'), slow = size(spec.slow ?? 20, 'slow');
    requireThat(fast < slow, 'STRATEGY_PARAMETER', 'fast must be smaller than slow');
    lookback = slow;
    decide = ({ history }) => {
      if (history.length < slow) { diagnostics.warmupBars++; return null; }
      const prices = history.slice(-slow).map(bar => BigInt(bar.close));
      return sum(prices.slice(-fast)) * BigInt(slow) > sum(prices) * BigInt(fast) ? spec.quantity : '0';
    };
  } else if (spec.type === 'volatility-breakout') {
    const entryWindow = size(spec.entryWindow ?? 20, 'entryWindow'), exitWindow = size(spec.exitWindow ?? 10, 'exitWindow');
    const atrWindow = size(spec.atrWindow ?? 14, 'atrWindow'), trendWindow = size(spec.trendWindow ?? 50, 'trendWindow');
    const riskBps = nat(spec.riskBps ?? '50', 'riskBps', true), trailingAtr = BigInt(size(spec.trailingAtr ?? 3, 'trailingAtr'));
    requireThat(riskBps <= 10000n, 'STRATEGY_PARAMETER', 'riskBps must not exceed 10000');
    const cooldownBars = size(spec.cooldownBars ?? 3, 'cooldownBars', 0);
    lookback = Math.max(entryWindow + 1, exitWindow + 1, atrWindow + 1, trendWindow);
    let previousPosition = 0n, peak = null, exitPending = false, cooldownUntil = -1, entryTarget = 0n;
    Object.assign(diagnostics, { entries: 0, exits: 0, filledEntries: 0, filledExits: 0, trailingExits: 0, channelExits: 0, cooldownBlocks: 0, zeroVolatilityBars: 0 });
    decide = ({ bar, history, ledger, equity, index }) => {
      const position = stateNat(ledger.quantity, 'ledger.quantity'), close = BigInt(bar.close);
      if (previousPosition > 0n && position === 0n) {
        peak = null; exitPending = false; entryTarget = 0n; cooldownUntil = index + cooldownBars; diagnostics.filledExits++;
      }
      if (previousPosition === 0n && position > 0n) diagnostics.filledEntries++;
      if (position > 0n) peak = maximum(peak ?? BigInt(bar.high), BigInt(bar.high));
      previousPosition = position;
      if (history.length < lookback) { diagnostics.warmupBars++; return null; }
      if (position > 0n && exitPending) return '0';
      const atrBars = history.slice(-atrWindow - 1);
      const trueRanges = atrBars.slice(1).map((item, i) => {
        const high = BigInt(item.high), low = BigInt(item.low), previousClose = BigInt(atrBars[i].close);
        const highGap = high >= previousClose ? high - previousClose : previousClose - high;
        const lowGap = low >= previousClose ? low - previousClose : previousClose - low;
        return maximum(high - low, maximum(highGap, lowGap));
      });
      const atrSum = sum(trueRanges);
      if (atrSum === 0n) { diagnostics.zeroVolatilityBars++; return position > 0n ? String(position) : '0'; }
      // Account valuation comes exclusively from the execution venue.
      if (equity === null) return null;
      const riskLots = stateNat(equity, 'equity') * riskBps * BigInt(atrWindow) / (10000n * atrSum * trailingAtr);
      const capped = BigInt(cappedLots(spec.quantity, spec.quantity, String(minimum(riskLots, BigInt(spec.quantity)))));
      if (position > 0n) {
        if (exitPending) return '0';
        const distance = (atrSum * trailingAtr + BigInt(atrWindow) - 1n) / BigInt(atrWindow);
        const trailing = peak > distance ? peak - distance : 0n;
        const previousLow = history.slice(-exitWindow - 1, -1).reduce((value, item) => minimum(value, BigInt(item.low)), BigInt(history.at(-2).low));
        const trailingHit = close <= trailing, channelHit = close < previousLow;
        if (trailingHit || channelHit) {
          exitPending = true; diagnostics.exits++; if (trailingHit) diagnostics.trailingExits++; if (channelHit) diagnostics.channelExits++;
          return '0';
        }
        // Preserve an entry's maximum exposure; increased ATR can only reduce it.
        entryTarget = minimum(entryTarget === 0n ? position : entryTarget, capped);
        return String(entryTarget);
      }
      if (index < cooldownUntil) { diagnostics.cooldownBlocks++; return '0'; }
      const previousHigh = history.slice(-entryWindow - 1, -1).reduce((value, item) => maximum(value, BigInt(item.high)), 0n);
      const trendSum = sum(history.slice(-trendWindow).map(item => BigInt(item.close)));
      if (close > previousHigh && close * BigInt(trendWindow) > trendSum && capped > 0n) {
        entryTarget = capped; diagnostics.entries++; return String(capped);
      }
      return '0';
    };
  } else {
    const featureWindow = size(spec.featureWindow ?? 12, 'featureWindow'), trainingWindow = size(spec.trainingWindow ?? 128, 'trainingWindow', 2);
    const minTrain = size(spec.minTrain ?? 32, 'minTrain', 2), retrainEvery = size(spec.retrainEvery ?? 16, 'retrainEvery');
    requireThat(minTrain <= trainingWindow, 'STRATEGY_PARAMETER', 'minTrain must not exceed trainingWindow');
    const alpha = numeric(spec.alpha ?? 1, 'alpha'); requireThat(alpha > 0, 'STRATEGY_PARAMETER', 'walkforward-ridge requires positive regularization');
    const entryThreshold = numeric(spec.entryThreshold ?? 0.0005, 'entryThreshold'), exitThreshold = numeric(spec.exitThreshold ?? 0, 'exitThreshold');
    requireThat(exitThreshold <= entryThreshold, 'STRATEGY_PARAMETER', 'exitThreshold must not exceed entryThreshold');
    const trainingTime = nat(spec.trainingTimeMs ?? '1', 'trainingTimeMs'), deploymentDelay = nat(spec.deploymentDelayMs ?? '1', 'deploymentDelayMs');
    const recordModels = spec.recordModels ?? true;
    requireThat(typeof recordModels === 'boolean', 'STRATEGY_PARAMETER', 'recordModels must be boolean');
    const schema = [
      { name: 'return-1', source: 'close', kind: 'return', lag: 1, unit: 'fraction' },
      { name: 'return-3', source: 'close', kind: 'return', lag: 3, unit: 'fraction' },
      { name: 'mean-return', source: 'return', kind: 'mean', window: featureWindow, unit: 'fraction' },
      { name: 'return-volatility', source: 'return', kind: 'std', window: featureWindow, unit: 'fraction' },
    ];
    const features = new RollingFeatures(schema), matured = [];
    let previousClose = null, previousFeature = null, previousPrediction = null, active = null, pending = null, lastFitIndex = -Infinity;
    let squaredError = 0, absoluteError = 0;
    Object.assign(diagnostics, { schema, fits: [], recordModels, predictions: 0, labeledPredictions: 0, predictionHashChain: hash('walkforward-predictions-v1'), lastPrediction: null, waitingForDeploymentBars: 0, mse: null, mae: null });
    decide = ({ bar, ledger, index, time }) => {
      // The source may publish a completed bar after its nominal availability.
      const close = Number(BigInt(bar.close)), now = BigInt(time);
      if (previousClose === null) { previousClose = close; diagnostics.warmupBars++; return null; }
      const realized = close / previousClose - 1;
      requireThat(Number.isFinite(realized), 'NONFINITE_FEATURE', 'Bar return must be finite');
      if (previousFeature?.ready) {
        matured.push({ id: `bar-${previousFeature.time}`, partition: 'train', feature: previousFeature, target: realized, labelAvailableAt: time });
        if (matured.length > trainingWindow + 1) matured.shift();
      }
      if (previousPrediction) {
        const error = previousPrediction.prediction - realized;
        squaredError += error * error; absoluteError += Math.abs(error); diagnostics.labeledPredictions++;
        requireThat(Number.isFinite(squaredError) && Number.isFinite(absoluteError), 'NONFINITE_MODEL', 'Prequential prediction errors exceed the supported finite numeric range');
        diagnostics.mse = squaredError / diagnostics.labeledPredictions; diagnostics.mae = absoluteError / diagnostics.labeledPredictions;
      }
      const feature = features.update({ time: bar.closeTime, availableAt: time, values: { close, return: realized } });
      previousClose = close; previousFeature = feature; previousPrediction = null;
      if (pending && BigInt(pending.model.deployedAt) <= now) { active = pending; pending = null; }
      const rows = matured.filter(row => BigInt(row.labelAvailableAt) < now).slice(-trainingWindow);
      if (feature.ready && !pending && rows.length >= minTrain && index - lastFitIndex >= retrainEvery) {
        const fold = `walkforward-${diagnostics.fits.length + 1}-${time}`;
        const completed = checked(now + trainingTime, 'training completion'), deployed = checked(completed + deploymentDelay, 'model deployment');
        const model = fitRidge({ training: createTrainingWindow(rows, { fold, cutoff: time }), schema, trainingStartedAt: time, trainingCompletedAt: String(completed), deployedAt: String(deployed), alpha });
        if (recordModels) modelArtifacts.push(model);
        pending = { model, fold }; lastFitIndex = index;
        diagnostics.fits.push({ fold, modelHash: model.hash, preprocessingHash: model.preprocessingHash, trainingDataHash: model.trainingDataHash, rowCount: rows.length,
          firstObservationTime: rows[0].feature.time, lastObservationTime: rows.at(-1).feature.time, lastLabelAvailableAt: model.lastLabelAvailableAt,
          cutoff: model.trainingCutoff, trainingStartedAt: model.trainingStartedAt, trainingCompletedAt: model.trainingCompletedAt, deployedAt: model.deployedAt });
        if (deployed <= now) { active = pending; pending = null; }
      }
      if (!feature.ready) { diagnostics.warmupBars++; return null; }
      if (!active) { diagnostics.waitingForDeploymentBars++; return null; }
      const prediction = predictRidge({ model: active.model, feature, schema, fold: active.fold, decisionTime: time });
      previousPrediction = prediction; diagnostics.predictions++;
      diagnostics.predictionHashChain = hash({ previous: diagnostics.predictionHashChain, predictionHash: prediction.hash });
      diagnostics.lastPrediction = { ...prediction, modelDeployedAt: active.model.deployedAt, trainingCutoff: active.model.trainingCutoff };
      const threshold = stateNat(ledger.quantity, 'ledger.quantity') > 0n ? exitThreshold : entryThreshold;
      return prediction.prediction > threshold ? spec.quantity : '0';
    };
  }

  return Object.freeze({
    lookback,
    onBar(context) {
      validateContext(context);
      requireThat(context.index > lastIndex && (lastAvailable === null || BigInt(context.bar.availableAt) > lastAvailable), 'STRATEGY_ORDER', 'Strategy calls must advance bar index and availability; create a fresh instance for another replay');
      const target = decide(context);
      if (target === null) diagnostics.unchangedTargets++;
      else { nat(target, 'target'); if (target === '0') diagnostics.flatTargets++; else diagnostics.longTargets++; }
      lastIndex = context.index; lastAvailable = BigInt(context.bar.availableAt); diagnostics.bars++;
      return target;
    },
    diagnostics: () => structuredClone(diagnostics),
    modelArtifacts: () => structuredClone(modelArtifacts),
  });
}
