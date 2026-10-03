import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, json, nat, requireThat } from '../../src/core.mjs';
import { loadProcessedInformationSource, processedManifest } from '../../src/market-data.mjs';
import { loadProcessedDerivativeData } from '../../src/executable-data.mjs';

export const configuration = {
  instrument: { symbol: 'ETH/USDT', currency: 'USDT-micro', lotSize: '0.001', priceTick: '10' },
  contract: { kind: 'perpetual', payoff: 'linear', contractValue: '1', settlementScale: '1',
    fundingIntervalMs: '28800000', fundingOffsetMs: '0', fundingTimestampToleranceMs: '0' },
  initialCash: '10000000000', maxPositionLots: '1000', initialMarginBps: '10000', maintenanceMarginBps: '500',
  feeBps: '5', liquidationFeeBps: '100', slippageBps: '10', orderLatencyMs: '1000', cancelLatencyMs: '1000',
  maxQuoteAgeMs: '120000', maxMarkAgeMs: '120000',
};

/** A bounded development-only input snapshot. No final observations are supplied. */
export async function prepareEthInputs({ sourceRoot, outputDirectory,
  firstDecisionTime = String(Date.parse('2026-09-01T00:01:00Z')),
  endTimeExclusive = String(Date.parse('2026-09-08T00:00:00Z')) }) {
  const first = nat(firstDecisionTime, 'firstDecisionTime'), end = nat(endTimeExclusive, 'endTimeExclusive');
  const septemberStart = BigInt(Date.parse('2026-09-01T00:00:00Z'));
  const septemberEnd = BigInt(Date.parse('2026-10-01T00:00:00Z'));
  requireThat(first > septemberStart && end <= septemberEnd && end > first && end - first <= 7n * 86400000n,
    'ETH_DEVELOPMENT_WINDOW', 'Select at most seven days inside development-exposed September');
  // The bridge selects completed-bar observation times before translating them
  // to publication times. Include the close one millisecond before decision.
  const coverageStartTime = String(first - 1n), endTime = String(end - 1n);
  const root = resolve(outputDirectory), processedRoot = join(resolve(sourceRoot), 'processed');
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root); // Each attempt owns a new directory; never overwrite one.
  const started = performance.now();
  try {
    const selections = [
      ['information', 'binance', 'bars'], ['quote', 'okx', 'bars'],
      ['mark', 'okx', 'markPrice'], ['funding', 'okx', 'funding'],
    ];
    const inputs = [];
    for (const [role, venue, kind] of selections) {
      const manifestPath = join(processedRoot, venue, 'ETH-USDT', '2026-09', kind, 'manifest.json');
      const manifest = await processedManifest(manifestPath);
      const source = manifest.recipe.source;
      requireThat(source.venue === venue && source.kind === kind && source.publicationDelayMs === '0',
        'ETH_INPUT_SOURCE', 'Require the declared undelayed September source');
      requireThat(BigInt(source.window.startTime) <= first - 1n && BigInt(source.window.endTime) >= end,
        'ETH_INPUT_COVERAGE', 'Processed selection must cover the complete requested window');
      inputs.push({ role, manifestPath, manifestSha256: createHash('sha256').update(await readFile(manifestPath)).digest('hex'),
        datasetHash: manifest.datasetHash, recipeHash: manifest.recipeHash,
        nativeManifestHash: source.manifestHash, nativeType: source.nativeType,
        instrument: source.instrument, units: source.units, quality: manifest.quality,
        sourceWindow: source.window, publicationDelayMs: source.publicationDelayMs,
        selectedShards: manifest.files.filter(file => BigInt(file.lastTime) >= first - 1n && BigInt(file.firstTime) < end),
        rawVerification: 'Native hashes are inherited provenance; raw archive bytes are not reread in this admission.' });
    }
    const path = role => inputs.find(input => input.role === role).manifestPath;
    const source = await loadProcessedInformationSource({ manifestPath: path('information'),
      startTime: coverageStartTime, endTime: endTimeExclusive, maxRows: 10100 });
    const observations = [...source.observations()].filter(row => BigInt(row.availableAt) >= first && BigInt(row.availableAt) < end);
    requireThat(observations.length > 0, 'ETH_INPUT_EMPTY', 'No admitted decision observations');
    const samples = observations.map((row, index) => ({ id: `minute-${index}`, time: row.availableAt,
      availableAt: row.availableAt, labelAvailableAt: row.availableAt }));
    for (let index = 0; index < observations.length; index++) {
      const row = observations[index];
      requireThat(BigInt(row.availableAt) === BigInt(row.time) + 1n &&
        (index === 0 ? row.availableAt === firstDecisionTime : BigInt(row.availableAt) - BigInt(observations[index - 1].availableAt) === 60000n),
      'ETH_DECISION_GAP', 'Require contiguous minute decisions at completed-bar publication');
    }
    requireThat(BigInt(observations.at(-1).availableAt) === end - 60000n,
      'ETH_DECISION_COVERAGE', 'Require complete minute decision coverage before exclusive end');
    const liquidity = { model: 'bar-volume', participationBps: '10', halfSpreadTicks: '10' };
    const execution = await loadProcessedDerivativeData({ config: configuration, quoteManifestPath: path('quote'),
      markManifestPath: path('mark'), fundingManifestPath: path('funding'),
      startTime: coverageStartTime, endTime, liquidity, markRounding: 'floor', maxEvents: 20300 });
    const informationIdentity = hash({ source: source.manifest, observations });
    const provenance = { schema: 'eth-intraday-admission-v1', developmentOnly: true,
      window: { coverageStartTime, firstDecisionTime, endTimeExclusive }, inputs,
      execution: execution.provenance, information: source.manifest,
      labelPolicy: 'Rule-only split metadata: labelAvailableAt equals decision availability; there are no forward training labels.',
      assumptions: [
        'September 2026 is development-exposed exploratory evidence; no final partition is present.',
        'Binance information is supplied independently of OKX derivative execution.',
        'Zero publication delay is assumed; local receipt times are unavailable.',
        'The OKX close-price/bar-volume execution proxy is not actual historical executable BBO or a queue model.',
        'Each quote has a 0.10 USDT per ETH half-spread and 0.1% of completed-bar ETH volume per side.',
        'The 5 bps fee is an assumed taker cost, not a verified historical account tier.',
        'The slippage parameter is a limit collar; fills use proxy quotes without a second slippage debit.',
        'Marks are explicitly floored from reference precision; funding uses the latest published fresh OKX mark.',
        'The exact fixed eight-hour funding schedule is admitted; settled funding is not supplied as a signal feature.',
        'Full collateral and a one ETH position cap are model settings, not historical exchange risk rules.',
        'Processed shard bytes/row counts are verified by shared loaders; native raw archive verification is inherited.',
      ] };
    const body = { schema: 'eth-intraday-input-v1', developmentOnly: true, finalPartition: [],
      config: configuration, data: execution.data, observations, samples,
      executionIdentity: execution.identity, informationIdentity, provenance };
    const dataset = { ...body, datasetHash: hash(body) };
    const encoded = json(dataset);
    const counts = {};
    for (const event of execution.data.events) counts[event.type] = (counts[event.type] ?? 0) + 1;
    const admission = { schema: 'eth-intraday-admission-summary-v1', datasetHash: dataset.datasetHash,
      datasetFileSha256: createHash('sha256').update(encoded).digest('hex'), datasetBytes: Buffer.byteLength(encoded),
      executionIdentity: execution.identity, informationIdentity, window: provenance.window,
      observations: observations.length, samples: samples.length, events: counts,
      selectedCompressedBytes: inputs.reduce((sum, input) => sum + input.selectedShards.reduce((n, file) => n + file.bytes, 0), 0),
      preparationMs: performance.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024,
      suggestedSplit: { trainSize: samples.length - 3 * 2880, validationSize: 2880, stepSize: 2880,
        embargoMs: '0', expanding: false, finalStart: samples.length },
      provenance };
    await writeFile(join(root, 'dataset.json'), encoded, { flag: 'wx' });
    await writeFile(join(root, 'admission.json'), json(admission), { flag: 'wx' });
    return { datasetPath: join(root, 'dataset.json'), admissionPath: join(root, 'admission.json'),
      datasetHash: dataset.datasetHash, observations: observations.length, events: counts, preparationMs: admission.preparationMs };
  } catch (error) {
    await writeFile(join(root, 'failure.json'), json({ code: error.code ?? 'ETH_INPUT_PREPARATION', message: error.message }), { flag: 'wx' });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [sourceRoot = 'data',
    outputDirectory = 'output/eth-intraday-inputs'] = process.argv.slice(2);
  console.log(json(await prepareEthInputs({ sourceRoot, outputDirectory })));
}
