import { checked, freeze, hash, nat, requireThat } from './core.mjs';
import { derivativeConfig, validateDerivativeData } from './derivative-data.mjs';
import { processedManifest, readProcessedData } from './market-data.mjs';

/** Admit verified processed ETH data to an explicit linear perpetual model.
 * Each input keeps its own ordering; merging only resolves cross-series ties.
 * The resulting immutable dataset can be shared by independent venue windows.
 */
export async function loadProcessedDerivativeData({ config: configuration, quoteManifestPath, markManifestPath, fundingManifestPath,
  startTime, endTime, liquidity, markRounding = 'exact', maxEvents = 1000000 }) {
  const config = derivativeConfig(configuration), start = nat(startTime, 'startTime'), end = nat(endTime, 'endTime');
  requireThat(start <= end, 'DATA_RANGE', 'Derivative coverage is inclusive and must not regress');
  requireThat(Number.isSafeInteger(maxEvents) && maxEvents > 0, 'DATA_SIZE', 'maxEvents must be a positive safe integer');
  requireThat(config.contract.kind === 'perpetual' && config.contract.payoff === 'linear'
    && config.contract.contractValue === '1' && config.instrument.symbol === 'ETH/USDT'
    && config.instrument.currency === 'USDT-micro' && config.instrument.lotSize === '0.001' && config.instrument.priceTick === '10',
  'DERIVATIVE_UNITS', 'Processed bridge requires a linear ETH/USDT perpetual in microUSDT per 0.001 ETH lot, multiplier 1 and tick 10');
  requireThat(['exact', 'floor'].includes(markRounding), 'DATA_PRECISION', 'markRounding must be exact or explicitly floor');
  requireThat(liquidity && Object.keys(liquidity).every(key => ['model', 'participationBps', 'halfSpreadTicks'].includes(key))
    && ['displayed-size', 'bar-volume'].includes(liquidity.model), 'LIQUIDITY_MODEL', 'Declare displayed-size or bar-volume liquidity');
  const participation = nat(liquidity.participationBps, 'participationBps', true);
  requireThat(participation <= 10000n, 'LIQUIDITY_MODEL', 'Participation must not exceed 10000 bps');
  if (liquidity.model === 'bar-volume') nat(liquidity.halfSpreadTicks, 'halfSpreadTicks');
  else requireThat(liquidity.halfSpreadTicks === undefined, 'LIQUIDITY_MODEL', 'Displayed quotes already contain their spread');
  const paths = [markManifestPath, fundingManifestPath, quoteManifestPath];
  const manifests = await Promise.all(paths.map(path => processedManifest(path)));
  const sources = manifests.map(manifest => manifest.recipe.source);
  const kinds = ['markPrice', 'funding', liquidity.model === 'bar-volume' ? 'bars' : 'bookTicker'];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    requireThat(source.kind === kinds[i] && source.venue === sources[0].venue && source.sourceMarket === 'linear USDT perpetual'
      && ['symbol', 'currency', 'lotSize', 'priceTick'].every(key => source.instrument[key] === config.instrument[key]),
    'UNIT_MISMATCH', 'Processed inputs must declare the same venue, perpetual market and canonical units');
    requireThat(BigInt(source.window.startTime) <= start && BigInt(source.window.endTime) > end,
      'DATA_COVERAGE', 'Every processed selection must cover the complete requested inclusive interval');
  }
  const provenance = freeze({ schema: 'processed-derivative-data-v1', sourceHashes: manifests.map(manifest => manifest.datasetHash),
    venue: sources[0].venue, window: { startTime, endTime }, liquidity: structuredClone(liquidity), markRounding,
    fundingSchedule: { intervalMs: config.contract.fundingIntervalMs, offsetMs: config.contract.fundingOffsetMs, timestampToleranceMs: config.contract.fundingTimestampToleranceMs ?? '0' },
    assumptions: [
      'Equal-time ordering is mark, funding, quote; it is an explicit model assumption, not an exchange sequence.',
      'Mark close becomes usable at publication time; funding uses the latest published mark, with configured maximum age.',
      'Funding fractions remain exact; only settlement postings round away from zero.',
      liquidity.model === 'bar-volume'
        ? 'Each completed bar supplies a close-price quote with the declared symmetric spread; each side receives the declared fraction of bar volume. This is a bar execution proxy.'
        : 'Each book update independently replenishes the declared fraction of displayed size. Queue position, persistent depletion and impact are not reconstructed.',
      markRounding === 'floor' ? 'Reference marks are explicitly floored to microUSDT per lot; trade quotes remain exact cent ticks.' : 'Reference marks must convert exactly to microUSDT per lot.',
    ] });
  const iterators = paths.map(manifestPath => readProcessedData({ manifestPath, startTime, endTime: String(checked(end + 1n, 'exclusive data end')) })[Symbol.asyncIterator]());
  const pending = [];
  let latestMark = null, sequence = 0n;
  const events = [];
  const advance = async index => {
    const item = await iterators[index].next();
    if (item.done) { pending[index] = null; return; }
    const record = item.value;
    const time = index === 1 || index === 2 && liquidity.model === 'displayed-size' ? record.time : record.availableAt;
    if (index === 1 || index === 2 && liquidity.model === 'displayed-size') {
      requireThat(record.availableAt === record.time, 'NON_EXECUTABLE_QUOTE', 'Funding and executable book events require undelayed source timestamps');
    }
    pending[index] = { record, time: nat(time, 'execution time') };
  };
  const price = value => {
    const scaled = nat(value, 'reference price', true);
    requireThat(markRounding === 'floor' || scaled % 100000n === 0n, 'DATA_PRECISION', 'Reference price does not convert exactly; choose an explicit rounding assumption');
    const result = scaled / 100000n;
    requireThat(result > 0n, 'DATA_PRECISION', 'Reference price rounds to zero');
    return String(result);
  };
  try {
    await Promise.all(iterators.map((_, index) => advance(index)));
    while (pending.some(Boolean)) {
      let selected = -1;
      for (let i = 0; i < pending.length; i++) if (pending[i] && (selected < 0 || pending[i].time < pending[selected].time)) selected = i;
      const { record, time } = pending[selected], row = record.data;
      if (time >= start && time <= end) {
        requireThat(events.length < maxEvents, 'DATA_SIZE', 'Derivative admission exceeded maxEvents; select a smaller dataset');
        const base = { id: `${kinds[selected]}:${row.eventId ?? record.time}`, time: String(time), sourceTime: String(time),
          sequence: String(++sequence), symbol: config.instrument.symbol, currency: config.instrument.currency };
        if (selected === 0) {
          latestMark = { price: price(row.close), time };
          events.push({ ...base, type: 'mark', price: latestMark.price });
        } else if (selected === 1) {
          requireThat(latestMark && time - latestMark.time <= BigInt(config.maxMarkAgeMs), 'STALE_MARK', 'Funding requires a preceding published fresh mark; extend input coverage before the first funding timestamp');
          events.push({ ...base, type: 'funding', price: latestMark.price, rate: row.rate });
        } else if (liquidity.model === 'displayed-size') {
          events.push({ ...base, type: 'quote', bid: row.bid, ask: row.ask,
            bidLots: String(nat(row.bidSizeLots, 'bidSizeLots') * participation / 10000n),
            askLots: String(nat(row.askSizeLots, 'askSizeLots') * participation / 10000n) });
        } else {
          const close = nat(row.close, 'bar close', true), spread = BigInt(liquidity.halfSpreadTicks) * BigInt(config.instrument.priceTick);
          requireThat(close > spread, 'DERIVATIVE_QUOTE', 'Bar spread must leave a positive bid');
          const lots = String(nat(row.volumeLots, 'bar volume') * participation / 10000n);
          events.push({ ...base, type: 'quote', bid: String(close - spread), ask: String(checked(close + spread, 'bar ask')), bidLots: lots, askLots: lots });
        }
      }
      await advance(selected);
    }
  } finally { await Promise.all(iterators.map(iterator => iterator.return?.())); }
  const finalManifests = await Promise.all(paths.map(path => processedManifest(path)));
  requireThat(finalManifests.every((manifest, index) => manifest.datasetHash === manifests[index].datasetHash), 'DATA_SOURCE_CHANGED', 'Processed manifest changed during derivative admission');
  requireThat(events.some(event => event.type === 'mark') && events.some(event => event.type === 'quote'), 'DATA_EMPTY', 'Derivative data requires risk marks and executable quotes');
  const data = validateDerivativeData({ startTime, endTime, events }, config);
  return freeze({ data, provenance, identity: hash({ data, provenance }) });
}
