// Public archives only. The final ZIP path is created only after Bend accepts
// the exact size and all eight SHA-256 words. No extraction or market conversion.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync, statfsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { archiveAccepted, checkArchiveBuild, parseChecksum, hashFile } from '../src/archive.mjs';

checkArchiveBuild();
const month = process.argv[2] || '2026-09';
if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Use YYYY-MM');
const root = resolve('data/binance/um/ETHUSDT', month);
mkdirSync(root, { recursive: true });
const report = { symbol: 'ETHUSDT', market: 'USD-M perpetual', month, startedAt: new Date().toISOString(), datasets: [] };
const save = () => {
  writeFileSync(join(root, 'manifest.json.tmp'), JSON.stringify(report, null, 2));
  renameSync(join(root, 'manifest.json.tmp'), join(root, 'manifest.json'));
};
function curl(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--silent', '--show-error', '--connect-timeout', '20', '--retry', '3', ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult(stdout) : reject(new Error(`curl ${code}: ${stderr.trim()}`)));
  });
}
function location(type, period, date) {
  const kline = /Klines$|^klines$/.test(type);
  const filename = `ETHUSDT-${kline ? '1m' : type}-${date}.zip`;
  return { filename, url: `https://data.binance.vision/data/futures/um/${period}/${type}/ETHUSDT/${kline ? '1m/' : ''}${filename}` };
}
async function acquire(type, period, date) {
  const { filename, url } = location(type, period, date);
  const record = { period, date, url, status: 'checking' };
  const head = await curl(['--head', '--max-time', '45', url]);
  const status = Number([...head.matchAll(/^HTTP\/\S+ (\d+)/gm)].at(-1)?.[1]);
  if (status === 404) return { ...record, status: 'unavailable', httpStatus: 404 };
  if (status !== 200) throw new Error(`${url}: HTTP ${status}`);
  const bytes = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1]);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`Missing size: ${url}`);
  const directory = join(root, type, period);
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, filename), partial = destination + '.part';
  const checksum = await curl(['--fail', '--max-time', '45', url + '.CHECKSUM']);
  const expected = parseChecksum(checksum, filename);
  writeFileSync(destination + '.CHECKSUM', checksum);
  if (existsSync(destination)) {
    const actual = await hashFile(destination);
    if (!archiveAccepted(expected, actual, BigInt(bytes), BigInt(statSync(destination).size))) throw new Error(`Existing archive failed verification: ${destination}`);
  } else {
    const free = statfsSync(directory, { bigint: true });
    if (free.bavail * free.bsize < BigInt(bytes) + 1073741824n) throw new Error(`Insufficient free disk space for ${filename}`);
    console.log(`Downloading ${type} ${date}: ${(bytes / 1e6).toFixed(1)} MB`);
    await curl(['--fail', '--max-time', '7200', '--output', partial, url]);
    const actual = await hashFile(partial);
    if (!archiveAccepted(expected, actual, BigInt(bytes), BigInt(statSync(partial).size))) throw new Error(`Bend rejected size/checksum: ${filename}`);
    renameSync(partial, destination);
  }
  console.log(`Verified ${type} ${date}`);
  return { ...record, status: 'verified', path: destination, bytes, sha256: expected, verifiedAt: new Date().toISOString() };
}
for (const type of ['fundingRate', 'markPriceKlines', 'indexPriceKlines', 'premiumIndexKlines', 'klines', 'bookTicker', 'trades']) {
  const dataset = { type, status: 'in-progress', files: [] };
  report.datasets.push(dataset); save();
  try {
    const monthly = await acquire(type, 'monthly', month);
    dataset.files.push(monthly); save();
    if (monthly.status === 'unavailable') {
      const [year, m] = month.split('-').map(Number);
      const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
      for (let day = 1; day <= days; day++) {
        dataset.files.push(await acquire(type, 'daily', `${month}-${String(day).padStart(2, '0')}`)); save();
      }
      dataset.status = dataset.files.slice(1).every(f => f.status === 'verified') ? 'complete' : 'incomplete';
    } else dataset.status = 'complete';
  } catch (error) { dataset.status = 'failed'; dataset.error = error.message; console.error(`${type}: ${error.message}`); }
  save();
}
report.finishedAt = new Date().toISOString();
report.complete = report.datasets.every(d => d.status === 'complete'); save();
console.log(JSON.stringify(report.datasets.map(d => ({ type: d.type, status: d.status, verified: d.files.filter(f => f.status === 'verified').length })), null, 2));
if (!report.complete) process.exitCode = 2;
