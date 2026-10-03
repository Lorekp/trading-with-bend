import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileHash, publish } from './support.mjs';

const sourcePath = fileURLToPath(new URL('./windows-collector.cs', import.meta.url));
const launcherPath = fileURLToPath(new URL('./linux-launcher.sh', import.meta.url));
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const readNumber = path => Number(readFileSync(path, 'utf8').trim());
const fields = path => Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n').map(line => line.trim().split(/\s+/)).map(([key, value]) => [key, Number(value)]));

function launch(executable, args, { directory, env, stdoutPath, stderrPath }) {
  const stdout = openSync(stdoutPath, 'wx'), stderr = openSync(stderrPath, 'wx');
  let child;
  try { child = spawn(executable, args, { cwd: directory, env, stdio: ['ignore', stdout, stderr], windowsHide: true }); }
  finally { closeSync(stdout); closeSync(stderr); }
  const exited = new Promise(resolveExit => {
    child.once('error', error => resolveExit({ code: null, signal: null, error: error.message }));
    child.once('exit', (code, signal) => resolveExit({ code, signal, error: null }));
  });
  return { child, exited };
}

export async function prepareCollector(runtime, directory) {
  if (process.platform === 'win32') {
    const compiler = join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    if (!existsSync(compiler)) throw new Error('COLLECTOR_UNAVAILABLE: .NET Framework C# compiler is required');
    const sourceHash = fileHash(sourcePath), root = resolve('.tools/memory');
    mkdirSync(root, { recursive: true });
    const executable = join(root, `collector-${sourceHash}.exe`);
    if (!existsSync(executable)) {
      const staged = join(root, `collector-${randomUUID()}.exe`);
      const compilerRun = launch(compiler, ['/nologo', '/optimize+', '/platform:x64', '/r:System.Web.Extensions.dll', `/out:${staged}`, sourcePath], {
        directory: process.cwd(), env: process.env, stdoutPath: join(directory, 'compiler.stdout.log'), stderrPath: join(directory, 'compiler.stderr.log') });
      const exit = await compilerRun.exited;
      if (exit.code !== 0) throw new Error(`COLLECTOR_BUILD: ${readFileSync(join(directory, 'compiler.stdout.log'), 'utf8')} ${exit.error ?? ''}`);
      renameSync(staged, executable);
    }
    return { source: 'windows-job', executable, sourceHash, binaryHash: fileHash(executable), compiler };
  }
  if (process.platform !== 'linux') throw new Error(`COLLECTOR_UNAVAILABLE: unsupported platform ${process.platform}`);
  const membership = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'));
  const parent = resolve(runtime.cgroupParent ?? `/sys/fs/cgroup${membership?.slice(3) ?? ''}`);
  const probe = join(parent, `bend-memory-probe-${randomUUID()}`);
  try {
    mkdirSync(probe);
    for (const name of ['memory.peak', 'memory.current', 'memory.events', 'memory.stat', 'cgroup.kill']) {
      if (!existsSync(join(probe, name))) throw new Error(`Missing ${name}`);
    }
  } catch (error) { throw new Error(`COLLECTOR_UNAVAILABLE: delegated cgroup v2 memory access required at ${parent}: ${error.message}`); }
  finally { if (existsSync(probe)) rmdirSync(probe); }
  return { source: 'linux-cgroup-v2', parent, sourceHash: fileHash(launcherPath) };
}

export async function collect(collector, specification, { sampleMs, budgetBytes, env, supervisor }) {
  const directory = specification.directory, specificationPath = join(directory, 'specification.json');
  const timelinePath = join(directory, 'timeline.ndjson'), resultPath = join(directory, 'collector.json');
  if (collector.source === 'windows-job') {
    const configuration = { resultPath, timelinePath, executable: process.execPath, supervisor,
      specification: specificationPath, cwd: process.cwd(), sampleMs, timeoutMs: specification.timeoutMs, budgetBytes: budgetBytes ?? 0 };
    publish(join(directory, 'collector-configuration.json'), configuration);
    const run = launch(collector.executable, [join(directory, 'collector-configuration.json')], {
      directory: process.cwd(), env, stdoutPath: join(directory, 'stdout.log'), stderrPath: join(directory, 'stderr.log') });
    const watchdog = setTimeout(() => run.child.kill(), specification.timeoutMs + 15000);
    let exit;
    try { exit = await run.exited; } finally { clearTimeout(watchdog); }
    if (!existsSync(resultPath)) return { status: 'collector-failed', peakCoverage: 'incomplete', exit };
    return { ...JSON.parse(readFileSync(resultPath, 'utf8')), helperExit: exit };
  }
  const group = join(collector.parent, `bend-memory-${process.pid}-${randomUUID()}`);
  let run, exit, timedOut = false;
  const started = process.hrtime.bigint(), initialCpu = process.cpuUsage();
  const ns = () => process.hrtime.bigint() - started;
  const timeline = openSync(timelinePath, 'wx');
  let samples = 0, missedReads = 0, sampledPeak = 0, maximumActive = 0, maximumGap = 0n, maximumDuration = 0n, prior = null;
  try {
    mkdirSync(group);
    if (budgetBytes !== undefined) writeFileSync(join(group, 'memory.max'), String(budgetBytes));
    // Swap is explicitly disabled for this group; this is recorded even without a budget.
    if (existsSync(join(group, 'memory.swap.max'))) writeFileSync(join(group, 'memory.swap.max'), '0');
    run = launch('/bin/sh', [launcherPath, group, process.execPath, supervisor, specificationPath], {
      directory: process.cwd(), env, stdoutPath: join(directory, 'stdout.log'), stderrPath: join(directory, 'stderr.log') });
    run.exited.then(value => { exit = value; });
    for (;;) {
      const before = ns(), pids = readFileSync(join(group, 'cgroup.procs'), 'utf8').trim().split(/\s+/).filter(Boolean);
      maximumActive = Math.max(maximumActive, pids.length);
      if (sampleMs > 0) {
        let residentBytes = 0;
        const readings = [];
        for (const pid of pids) {
          try {
            const status = readFileSync(`/proc/${pid}/status`, 'utf8');
            const resident = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
            const high = Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024;
            residentBytes += resident; readings.push({ pid: Number(pid), residentBytes: resident, residentHighWaterBytes: high });
          } catch { missedReads++; }
        }
        const after = ns(), duration = after - before;
        maximumDuration = duration > maximumDuration ? duration : maximumDuration;
        if (prior !== null && before - prior > maximumGap) maximumGap = before - prior;
        prior = before; samples++; sampledPeak = Math.max(sampledPeak, residentBytes);
        writeFileSync(timeline, `${JSON.stringify({ elapsedNs: String(before), durationNs: String(duration), activeProcesses: pids.length,
          residentBytes, chargedBytes: readNumber(join(group, 'memory.current')), memoryStat: fields(join(group, 'memory.stat')), readings })}\n`);
      }
      const populated = fields(join(group, 'cgroup.events')).populated;
      if (exit && populated === 0) break;
      if (!timedOut && Number(ns() / 1000000n) >= specification.timeoutMs) {
        timedOut = true; writeFileSync(join(group, 'cgroup.kill'), '1');
      }
      if (timedOut && Number(ns() / 1000000n) > specification.timeoutMs + 10000) throw new Error('Timed-out cgroup failed to drain');
      await delay(sampleMs > 0 ? sampleMs : 50);
    }
    const result = { source: collector.source, status: timedOut ? 'timeout' : 'completed', rootPid: run.child.pid,
      rootExitCode: exit.code, rootSignal: exit.signal, groupChargedPeakBytes: readNumber(join(group, 'memory.peak')),
      elapsedNs: String(ns()), peakCoverage: 'complete', sampledTreeResidentPeakBytes: sampleMs > 0 ? sampledPeak : null,
      sampleCount: samples, maximumGapNs: String(maximumGap), maximumSampleDurationNs: String(maximumDuration),
      maximumActiveProcesses: maximumActive, missedProcessReads: missedReads, memoryEvents: fields(join(group, 'memory.events')),
      swapBytes: existsSync(join(group, 'memory.swap.current')) ? readNumber(join(group, 'memory.swap.current')) : null,
      swapPolicy: 'disabled', budgetBytes: budgetBytes ?? null, observerCpuMs: (process.cpuUsage(initialCpu).user + process.cpuUsage(initialCpu).system) / 1000,
      observerPeakResidentBytes: process.resourceUsage().maxRSS * 1024 };
    publish(resultPath, result); return result;
  } finally {
    closeSync(timeline);
    if (existsSync(group)) {
      if (fields(join(group, 'cgroup.events')).populated) { writeFileSync(join(group, 'cgroup.kill'), '1'); await run?.exited; }
      rmdirSync(group);
    }
  }
}

export function artifactHashes(directory) {
  const hashes = {};
  function visit(root, prefix = '') {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(root, entry.name), `${name}/`);
      else if (entry.isFile()) hashes[name] = fileHash(join(root, entry.name));
      else throw new Error(`Non-regular benchmark artifact ${name}`);
    }
  }
  visit(directory); return hashes;
}
