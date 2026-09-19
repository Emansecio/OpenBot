/** Built-in .NET helper. Jobs control lifecycle only; the Windows user and host access are unchanged. */
export const WINDOWS_JOB_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class OpenBotJob {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long a,b; public uint flags; public UIntPtr min,max; public uint count; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long a,b,c,d; public uint faults,total,active,terminated; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUP { public int cb; public string reserved,desktop,title; public int x,y,xsize,ysize,xcount,ycount,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUP_EX { public STARTUP startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFO { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref LIMIT info,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNTING info,int size,IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr ownerJob = IntPtr.Zero;
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY security,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUP_EX startup,out PROCESS_INFO info);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  static readonly object outputLock = new object();
  static void Check(bool success) { if (!success) throw new Exception("Native job operation failed: " + Marshal.GetLastWin32Error()); }
  public static void WatchOwner() {
    // This pipe is held open by the gateway, never inherited by the command.
    // EOF also detects a forced gateway exit; no PID or parent enumeration.
    var watcher = new System.Threading.Thread(() => { try { Console.In.ReadLine(); } catch {} Environment.Exit(2); });
    watcher.IsBackground = true; watcher.Start();
  }
  public static int Main() {
    Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
    IntPtr job = IntPtr.Zero;
    try {
      var json = new JavaScriptSerializer(); json.MaxJsonLength = 16 * 1024 * 1024;
      string line = Console.In.ReadLine(); if(line == null) return 0;
      var hello = json.Deserialize<Dictionary<string,object>>(line);
      string name = (string)hello["name"];
      if((string)hello["mode"] == "recover") { Recover(name); return 0; }
      if((string)hello["mode"] == "inspect") { Emit(Exists(name) ? "present" : "absent"); return 0; }
      if((string)hello["mode"] != "create") return 1;
      job = Create(name); Emit("{\"kind\":\"ready\"}");
      line = Console.In.ReadLine(); if(line == null) return 0;
      WatchOwner();
      var request = json.Deserialize<Dictionary<string,object>>(line);
      foreach(var entry in (Dictionary<string,object>)request["env"]) Environment.SetEnvironmentVariable(entry.Key,(string)entry.Value);
      Run(job,(string)request["command"],(string)request["cwd"],(string)request["stdin"]);
      return 0;
    } catch { Console.Error.WriteLine("Native job operation failed."); return 1; }
    finally { Close(job); }
  }
  public static void Emit(string value) { lock(outputLock) { Console.Out.WriteLine(value); Console.Out.Flush(); } }
  static IntPtr NewJob(string name) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero,name); int error = Marshal.GetLastWin32Error();
    if (job == IntPtr.Zero) throw new Exception("Native job could not be created.");
    if (name != null && error == 183) { CloseHandle(job); throw new Exception("Native job identity already exists."); }
    try { LIMIT limits = new LIMIT(); limits.basic.flags = 0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(LIMIT)))); return job; }
    catch { CloseHandle(job); throw; }
  }
  public static IntPtr Create(string name) {
    ownerJob = NewJob(name);
    // Recovery owns the supervisor too: there can be no delayed spawn after teardown.
    Check(AssignProcessToJobObject(ownerJob,GetCurrentProcess()));
    return NewJob(null);
  }
  public static void Close(IntPtr job) { if(job != IntPtr.Zero) CloseHandle(job); }
  public static void Clean(IntPtr job) {
    Check(TerminateJobObject(job,1));
    DateTime deadline = DateTime.UtcNow.AddSeconds(10);
    while(true) { ACCOUNTING info; Check(QueryInformationJobObject(job,1,out info,Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero)); if(info.active == 0) return; if(DateTime.UtcNow >= deadline) throw new Exception("Native job teardown was not verified."); System.Threading.Thread.Sleep(10); }
  }
  public static bool Exists(string name) {
    IntPtr job = OpenJobObjectW(0x0004,false,name);
    if(job == IntPtr.Zero) { if(Marshal.GetLastWin32Error() == 2) return false; throw new Exception("Native job identity could not be verified."); }
    CloseHandle(job); return true;
  }
  public static void Recover(string name) {
    IntPtr job = OpenJobObjectW(0x0008|0x0004,false,name);
    if(job == IntPtr.Zero) { if(Marshal.GetLastWin32Error() == 2) return; throw new Exception("Native job identity could not be verified."); }
    try { Clean(job); } finally { CloseHandle(job); }
  }
  static Task Drain(IntPtr handle,string kind) {
    return Task.Run(() => { using(FileStream stream = new FileStream(new SafeFileHandle(handle,true),FileAccess.Read,8192,false)) { byte[] bytes = new byte[8192]; int count; while((count=stream.Read(bytes,0,bytes.Length)) != 0) Emit("{\"kind\":\""+kind+"\",\"data\":\""+Convert.ToBase64String(bytes,0,count)+"\"}"); } });
  }
  public static void Run(IntPtr job,string command,string cwd,string input) {
    // CreateProcess executable lookup uses the caller cwd, not lpCurrentDirectory.
    Environment.CurrentDirectory = cwd;
    IntPtr ir=IntPtr.Zero,iw=IntPtr.Zero,or=IntPtr.Zero,ow=IntPtr.Zero,er=IntPtr.Zero,ew=IntPtr.Zero,attrs=IntPtr.Zero,jobs=IntPtr.Zero,handles=IntPtr.Zero;
    PROCESS_INFO pi = new PROCESS_INFO(); bool initialized=false;
    try {
      SECURITY sa = new SECURITY(); sa.length=Marshal.SizeOf(typeof(SECURITY)); sa.inherit=true;
      Check(CreatePipe(out ir,out iw,ref sa,0)); Check(SetHandleInformation(iw,1,0));
      Check(CreatePipe(out or,out ow,ref sa,0)); Check(SetHandleInformation(or,1,0));
      Check(CreatePipe(out er,out ew,ref sa,0)); Check(SetHandleInformation(er,1,0));
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
      attrs=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs,2,0,ref size)); initialized=true;
      jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
      // Windows 10+ assigns the Job Object atomically, before any child code runs.
      Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      handles=Marshal.AllocHGlobal(3*IntPtr.Size); Marshal.WriteIntPtr(handles,0,ir); Marshal.WriteIntPtr(handles,IntPtr.Size,ow); Marshal.WriteIntPtr(handles,2*IntPtr.Size,ew);
      Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      STARTUP_EX si = new STARTUP_EX(); si.startup.cb=Marshal.SizeOf(typeof(STARTUP_EX)); si.startup.flags=0x100; si.startup.input=ir; si.startup.output=ow; si.startup.error=ew; si.attributes=attrs;
      Check(CreateProcessW(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x00080000|0x08000000,IntPtr.Zero,cwd,ref si,out pi));
      CloseHandle(ir); ir=IntPtr.Zero; CloseHandle(ow); ow=IntPtr.Zero; CloseHandle(ew); ew=IntPtr.Zero;
      Task stdout=Drain(or,"stdout"); or=IntPtr.Zero; Task stderr=Drain(er,"stderr"); er=IntPtr.Zero;
      IntPtr writer=iw; iw=IntPtr.Zero;
      Task stdin=Task.Run(() => { try { using(FileStream stream=new FileStream(new SafeFileHandle(writer,true),FileAccess.Write,8192,false)) { byte[] bytes=Encoding.UTF8.GetBytes(input ?? ""); stream.Write(bytes,0,bytes.Length); } } catch(IOException) { Emit("{\"kind\":\"stdin-error\"}"); } });
      Check(WaitForSingleObject(pi.process,0xFFFFFFFF)==0); uint exit; Check(GetExitCodeProcess(pi.process,out exit));
      Clean(job); Task.WaitAll(stdout,stderr,stdin);
      Emit("{\"kind\":\"exit\",\"code\":"+exit+"}");
    } finally {
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
      foreach(IntPtr h in new IntPtr[]{ir,iw,or,ow,er,ew}) if(h!=IntPtr.Zero) CloseHandle(h);
      if(initialized) DeleteProcThreadAttributeList(attrs); if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs); if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs); if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
    }
  }
}`;

const POWERSHELL_JOB_SOURCE = WINDOWS_JOB_SOURCE.slice(0, WINDOWS_JOB_SOURCE.indexOf("  public static int Main()")) +
  WINDOWS_JOB_SOURCE.slice(WINDOWS_JOB_SOURCE.indexOf("  public static void Emit("));

/** Compatibility fallback when no managed runtime cache was supplied. */
export const WINDOWS_JOB_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll -TypeDefinition @'
${POWERSHELL_JOB_SOURCE}
'@
$job = [IntPtr]::Zero
try {
  $hello = [Console]::ReadLine() | ConvertFrom-Json
  if ($hello.mode -eq 'recover') { [OpenBotJob]::Recover($hello.name); exit 0 }
  if ($hello.mode -ne 'create') { throw 'Invalid native job command.' }
  $job = [OpenBotJob]::Create($hello.name)
  [OpenBotJob]::Emit('{"kind":"ready"}')
  $line = [Console]::ReadLine()
  if ($null -eq $line) { exit 0 }
  [OpenBotJob]::WatchOwner()
  $request = $line | ConvertFrom-Json
  foreach ($entry in $request.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process') }
  [OpenBotJob]::Run($job, $request.command, $request.cwd, $request.stdin)
} catch { [Console]::Error.WriteLine('Native job operation failed.'); exit 1 }
finally { [OpenBotJob]::Close($job) }
`;
