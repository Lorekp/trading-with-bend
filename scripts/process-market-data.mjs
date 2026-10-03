import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openMarketSource, prepareMarketData } from '../src/index.mjs';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/process-market-data.mjs configuration.json');
const { outputDirectory, ...configuration } = JSON.parse(await readFile(path, 'utf8'));
const started = performance.now();
const source = await openMarketSource(configuration);
console.log(`Processing ${configuration.venue} ${configuration.kind}; raw files stay immutable`);
const result = await prepareMarketData({ source, outputDirectory });
console.log(JSON.stringify({ manifestPath: resolve(outputDirectory, 'manifest.json'), datasetHash: result.datasetHash,
  rows: result.rows, files: result.files.length, quality: result.quality, seconds: (performance.now() - started) / 1000,
  peakRssMiB: process.resourceUsage().maxRSS / 1024 }, null, 2));
