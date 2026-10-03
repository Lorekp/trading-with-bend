// Compiled locally against .NET Framework. The observer never joins the measured job.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class MemoryCollector {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessLimit, JobLimit, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessMemory {
    public uint Size, PageFaults;
    public UIntPtr PeakWorkingSet, WorkingSet, PeakPagedPool, PagedPool,
      PeakNonPagedPool, NonPagedPool, Pagefile, PeakPagefile, Private;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint Pid, Tid;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
    bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("psapi.dll", SetLastError = true)] static extern bool GetProcessMemoryInfo(IntPtr process, ref ProcessMemory memory, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size, uint type, uint protection);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool VirtualFree(IntPtr address, UIntPtr size, uint type);

  static void Check(bool ok, string operation) {
    if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static T Query<T>(IntPtr job, int infoClass) {
    int length = Marshal.SizeOf(typeof(T));
    IntPtr data = Marshal.AllocHGlobal(length);
    try {
      Check(QueryInformationJobObject(job, infoClass, data, (uint)length, IntPtr.Zero), "QueryInformationJobObject");
      return (T)Marshal.PtrToStructure(data, typeof(T));
    } finally { Marshal.FreeHGlobal(data); }
  }
  static uint[] Pids(IntPtr job) {
    int capacity = 64;
    while (capacity <= 65536) {
      int length = 8 + capacity * IntPtr.Size;
      IntPtr data = Marshal.AllocHGlobal(length);
      try {
        if (!QueryInformationJobObject(job, 3, data, (uint)length, IntPtr.Zero)) {
          if (Marshal.GetLastWin32Error() == 234) { capacity *= 2; continue; }
          Check(false, "Query job process list");
        }
        int count = Marshal.ReadInt32(data, 4);
        uint[] result = new uint[count];
        for (int i = 0; i < count; i++) result[i] = (uint)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64();
        return result;
      } finally { Marshal.FreeHGlobal(data); }
    }
    throw new Exception("Job process list exceeds collector limit");
  }
  // CommandLineToArgvW quoting, including trailing slashes before a closing quote.
  static string Quote(string value) {
    StringBuilder result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0;
      result.Append(c);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  static long Ns(Stopwatch clock) { return (long)(clock.ElapsedTicks * (1000000000.0 / Stopwatch.Frequency)); }
  static void Save(string path, object value, JavaScriptSerializer json) {
    using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write))
    using (StreamWriter writer = new StreamWriter(file, new UTF8Encoding(false))) writer.WriteLine(json.Serialize(value));
  }
  static int Main(string[] args) {
    // Native allocation calibration: same contained descendant executable, no V8 heap.
    if (args[0] == "--burst") {
      int bytes = Int32.Parse(args[1]), milliseconds = Int32.Parse(args[2]);
      IntPtr data = VirtualAlloc(IntPtr.Zero, new UIntPtr((uint)bytes), 0x3000, 4);
      Check(data != IntPtr.Zero, "VirtualAlloc");
      try {
        for (int offset = 0; offset < bytes; offset += 4096) Marshal.WriteByte(data, offset, 1);
        Console.WriteLine(bytes);
        Thread.Sleep(milliseconds);
      } finally { Check(VirtualFree(data, UIntPtr.Zero, 0x8000), "VirtualFree"); }
      return 0;
    }
    JavaScriptSerializer json = new JavaScriptSerializer();
    Dictionary<string, object> config = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(args[0]));
    string resultPath = (string)config["resultPath"];
    IntPtr job = IntPtr.Zero; ProcessInfo root = new ProcessInfo(); bool assigned = false;
    Stopwatch clock = Stopwatch.StartNew();
    TimeSpan initialCpu = Process.GetCurrentProcess().TotalProcessorTime;
    try {
      job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject");
      ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway
      ulong budget = Convert.ToUInt64(config["budgetBytes"]);
      if (budget > 0) { limits.Basic.Flags |= 0x200; limits.JobLimit = new UIntPtr(budget); }
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "SetInformationJobObject");
      Startup startup = new Startup(); startup.Size = (uint)Marshal.SizeOf(typeof(Startup)); startup.Flags = 0x100;
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      string executable = (string)config["executable"];
      StringBuilder command = new StringBuilder(Quote(executable) + " " + Quote((string)config["supervisor"]) + " " + Quote((string)config["specification"]));
      Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero,
        (string)config["cwd"], ref startup, out root), "CreateProcess suspended");
      Check(AssignProcessToJobObject(job, root.Process), "AssignProcessToJobObject"); assigned = true;
      Check(ResumeThread(root.Thread) != UInt32.MaxValue, "ResumeThread"); CloseHandle(root.Thread); root.Thread = IntPtr.Zero;
      uint rootPid = root.Pid, exitCode = 259; bool timedOut = false; string rootExitNs = null;
      int sampleMs = Convert.ToInt32(config["sampleMs"]), timeoutMs = Convert.ToInt32(config["timeoutMs"]);
      long samples = 0, maxGapNs = 0, maxSampleNs = 0, previousNs = 0, missedReads = 0;
      ulong residentPeak = 0; uint maxActive = 0;
      using (FileStream file = new FileStream((string)config["timelinePath"], FileMode.CreateNew, FileAccess.Write, FileShare.Read))
      using (StreamWriter timeline = new StreamWriter(file, new UTF8Encoding(false))) {
        for (;;) {
          Accounting accounting = Query<Accounting>(job, 1); maxActive = Math.Max(maxActive, accounting.ActiveProcesses);
          if (sampleMs > 0) {
            long before = Ns(clock); List<object> readings = new List<object>(); ulong resident = 0;
            foreach (uint pid in Pids(job)) {
              IntPtr process = OpenProcess(0x1000, false, pid);
              if (process == IntPtr.Zero) { missedReads++; continue; }
              try {
                ProcessMemory memory = new ProcessMemory(); memory.Size = (uint)Marshal.SizeOf(typeof(ProcessMemory));
                if (!GetProcessMemoryInfo(process, ref memory, memory.Size)) { missedReads++; continue; }
                resident += memory.WorkingSet.ToUInt64();
                readings.Add(new { pid = pid, residentBytes = memory.WorkingSet.ToUInt64(),
                  residentHighWaterBytes = memory.PeakWorkingSet.ToUInt64(), privateCommittedBytes = memory.Private.ToUInt64() });
              } finally { CloseHandle(process); }
            }
            long after = Ns(clock); maxSampleNs = Math.Max(maxSampleNs, after - before);
            if (samples > 0) maxGapNs = Math.Max(maxGapNs, before - previousNs);
            previousNs = before; samples++; residentPeak = Math.Max(residentPeak, resident);
            timeline.WriteLine(json.Serialize(new { elapsedNs = before.ToString(), durationNs = (after - before).ToString(),
              activeProcesses = accounting.ActiveProcesses, residentBytes = resident, readings = readings }));
            timeline.Flush();
          }
          if (root.Process != IntPtr.Zero && WaitForSingleObject(root.Process, 0) == 0) {
            Check(GetExitCodeProcess(root.Process, out exitCode), "GetExitCodeProcess"); CloseHandle(root.Process); root.Process = IntPtr.Zero;
            rootExitNs = Ns(clock).ToString();
          }
          if (accounting.ActiveProcesses == 0) break;
          if (!timedOut && clock.ElapsedMilliseconds >= timeoutMs) {
            timedOut = true; Check(TerminateJobObject(job, 124), "TerminateJobObject");
          }
          if (timedOut && clock.ElapsedMilliseconds > timeoutMs + 10000) throw new Exception("Timed-out job failed to drain");
          Thread.Sleep(sampleMs > 0 ? sampleMs : 50);
        }
      }
      limits = Query<ExtendedLimits>(job, 9); Accounting final = Query<Accounting>(job, 1);
      Save(resultPath, new { status = timedOut ? "timeout" : "completed", source = "windows-job", rootPid = rootPid,
        rootExitCode = exitCode, rootExitElapsedNs = rootExitNs, elapsedNs = Ns(clock).ToString(), groupCommittedPeakBytes = limits.PeakJob.ToUInt64(),
        sampledTreeResidentPeakBytes = sampleMs > 0 ? (object)residentPeak : null,
        peakCoverage = "complete", sampleCount = samples, maximumGapNs = maxGapNs.ToString(), maximumSampleDurationNs = maxSampleNs.ToString(),
        missedProcessReads = missedReads, maximumActiveProcesses = maxActive, totalProcesses = final.TotalProcesses,
        pageFaults = final.PageFaults, groupCpuNs = ((final.UserTime + final.KernelTime) * 100).ToString(),
        observerCpuMs = (Process.GetCurrentProcess().TotalProcessorTime - initialCpu).TotalMilliseconds,
        observerPeakResidentBytes = Process.GetCurrentProcess().PeakWorkingSet64, budgetBytes = budget }, json);
      return 0;
    } catch (Exception error) {
      if (root.Process != IntPtr.Zero && !assigned) TerminateProcess(root.Process, 125);
      Save(resultPath, new { status = "collector-failed", peakCoverage = "incomplete", error = error.ToString() }, json);
      return 1;
    } finally {
      if (root.Thread != IntPtr.Zero) CloseHandle(root.Thread);
      if (root.Process != IntPtr.Zero) CloseHandle(root.Process);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
