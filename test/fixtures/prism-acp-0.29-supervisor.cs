// prism-acp 0.29.0's Windows process-tree supervisor, verbatim (SUPERVISOR_CS in dist/process-tree-supervisor-cs.js; MIT, Particle Academy).
// Kept so a test can build the supervisor that a Genie on prism-acp 0.29 or older left in its runtime folder.
// prism-acp process-tree supervisor (Windows). Runs ONE provider inside a Job Object and ends the whole tree with it.
//
// Protocol, one ASCII line each way over the named pipe in PRISM_ACP_TREE_CHANNEL:
//   -> hello <token>                       (the token from PRISM_ACP_TREE_TOKEN)
//   <- spawn <base64 application> <base64 command line> <base64 cwd>
//   -> started <pid>        | failed <win32 error>
//   <- kill                 (or the pipe closes: the client is gone)
//   -> exited <code>        (the provider ended on its own)
//   -> empty <active>       (the job was terminated; active = processes left, 0 when the tree is gone)
//
// The job has KILL_ON_JOB_CLOSE and no breakaway, and only this process holds its handle, so whatever ends this
// process -- a kill, a crash, the client's death taking it down -- ends every process in the tree.
using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class Supervisor
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BasicAccounting
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo
    {
        public int cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint CREATE_SUSPENDED = 0x4;
    const int STARTF_USESTDHANDLES = 0x100;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out BasicAccounting info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    static StreamWriter control;
    static readonly object writeLock = new object();

    static void Say(string line)
    {
        lock (writeLock)
        {
            try { control.Write(line + "\n"); control.Flush(); } catch { }
        }
    }

    static string Unbase64(string s)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(s));
    }

    static uint Active(IntPtr job)
    {
        BasicAccounting info;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, Marshal.SizeOf(typeof(BasicAccounting)), IntPtr.Zero)) return uint.MaxValue;
        return info.ActiveProcesses;
    }

    /** Terminate every process in the job, then wait (up to 5 s) for the job to report none left. */
    static uint EndTree(IntPtr job)
    {
        TerminateJobObject(job, 1);
        uint active = Active(job);
        for (int i = 0; i < 250 && active != 0; i++) { Thread.Sleep(20); active = Active(job); }
        return active;
    }

    // Mutual authentication: a squatter never receives the secret or a spawn
    // specification. Every handshake is bounded and consumes exactly its LF.
    static string AuthMac(string token, string text)
    {
        using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(token)))
            return BitConverter.ToString(hmac.ComputeHash(Encoding.ASCII.GetBytes(text))).Replace("-", "").ToLowerInvariant();
    }

    static bool Same(string left, string right)
    {
        if (left == null || left.Length != right.Length) return false;
        int difference = 0;
        for (int i = 0; i < right.Length; i++) difference |= left[i] ^ right[i];
        return difference == 0;
    }

    static string AuthRead(PipeStream pipe, Stopwatch clock)
    {
        var line = new StringBuilder(); var one = new byte[1];
        while (line.Length <= 192)
        {
            int remaining = 5000 - (int)clock.ElapsedMilliseconds;
            if (remaining <= 0) throw new TimeoutException();
            var pending = pipe.BeginRead(one, 0, 1, null, null);
            using (var wait = pending.AsyncWaitHandle)
            {
                if (!wait.WaitOne(remaining)) throw new TimeoutException();
                if (pipe.EndRead(pending) == 0) throw new EndOfStreamException();
            }
            if (one[0] == 10) return line.ToString();
            if (one[0] < 32 || one[0] > 126) throw new FormatException();
            line.Append((char)one[0]);
        }
        throw new FormatException();
    }

    static void AuthWrite(PipeStream pipe, string line, Stopwatch clock)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
        int remaining = 5000 - (int)clock.ElapsedMilliseconds;
        if (remaining <= 0) throw new TimeoutException();
        var pending = pipe.BeginWrite(bytes, 0, bytes.Length, null, null);
        using (var wait = pending.AsyncWaitHandle)
        {
            if (!wait.WaitOne(remaining)) throw new TimeoutException();
            pipe.EndWrite(pending);
        }
    }

    static NamedPipeServerStream ConnectLocal(string channel, string token, string kind)
    {
        const string prefix = @"\\.\pipe\LOCAL\prism-acp-";
        if (channel == null || !channel.StartsWith(prefix, StringComparison.Ordinal)) throw new FormatException();
        var clock = Stopwatch.StartNew();
        // Protected from creation: no Everyone, anonymous, group, or all-apps grants.
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        using (var identity = WindowsIdentity.GetCurrent())
        {
            security.AddAccessRule(new PipeAccessRule(identity.User, PipeAccessRights.FullControl, AccessControlType.Allow));
            int length;
            GetTokenInformation(identity.Token, 31, IntPtr.Zero, 0, out length);
            if (length <= 0) throw new IOException();
            IntPtr data = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(identity.Token, 31, data, length, out length)) throw new IOException();
                IntPtr sid = Marshal.ReadIntPtr(data);
                if (sid != IntPtr.Zero) security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.FullControl, AccessControlType.Allow));
            }
            finally { Marshal.FreeHGlobal(data); }
        }
        var pipe = new NamedPipeServerStream(channel.Substring(@"\\.\pipe\".Length), PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security);
        try
        {
            var pending = pipe.BeginWaitForConnection(null, null);
            using (var wait = pending.AsyncWaitHandle)
            {
                if (!wait.WaitOne(5000)) throw new TimeoutException();
                pipe.EndWaitForConnection(pending);
            }
            byte[] random = new byte[32];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(random);
            string nonce = BitConverter.ToString(random).Replace("-", "").ToLowerInvariant();
            AuthWrite(pipe, "hello " + kind + " " + nonce, clock);
            if (!Same(AuthRead(pipe, clock), "auth " + AuthMac(token, "host " + kind + " " + nonce))) throw new FormatException();
            AuthWrite(pipe, "ready " + AuthMac(token, "supervisor " + kind + " " + nonce), clock);
            return pipe;
        }
        catch { pipe.Dispose(); throw; }
    }

    static int Main()
    {
        string channel = Environment.GetEnvironmentVariable("PRISM_ACP_TREE_CHANNEL");
        string token = Environment.GetEnvironmentVariable("PRISM_ACP_TREE_TOKEN");
        // Never inherited by the provider.
        Environment.SetEnvironmentVariable("PRISM_ACP_TREE_CHANNEL", null);
        Environment.SetEnvironmentVariable("PRISM_ACP_TREE_TOKEN", null);
        if (string.IsNullOrEmpty(channel) || string.IsNullOrEmpty(token)) return 125;
        const string prefix = @"\\.\pipe\";
        if (!channel.StartsWith(prefix)) return 125;

        // Overlapped: a synchronous pipe handle serialises I/O, so a write would wait behind the listener's pending read.
        bool local = channel.StartsWith(@"\\.\pipe\LOCAL\prism-acp-", StringComparison.Ordinal);
        string[] ioChannels = new string[3];
        if (local) for (int i = 0; i < 3; i++)
        {
            ioChannels[i] = Environment.GetEnvironmentVariable("PRISM_ACP_TREE_IO_" + i);
            Environment.SetEnvironmentVariable("PRISM_ACP_TREE_IO_" + i, null);
        }
        // No Console streams: bootstrap files are read-only. Report failures
        // over authenticated control, or exit for the host to report its code.
        // Bootstrap handles are unused and must not leak into the provider.
        if (local) foreach (int standard in new int[] { -10, -11, -12 })
            if (!SetHandleInformation(GetStdHandle(standard), 1, 0)) return 125;
        PipeStream pipe;
        try
        {
            if (local) pipe = ConnectLocal(channel, token, "control");
            else { var ordinary = new NamedPipeClientStream(".", channel.Substring(prefix.Length), PipeDirection.InOut, PipeOptions.Asynchronous); ordinary.Connect(10000); pipe = ordinary; }
        }
        catch { return 125; }
        var reader = new StreamReader(pipe, new UTF8Encoding(false));
        control = new StreamWriter(pipe, new UTF8Encoding(false));
        if (!local) Say("hello " + token);

        string spec = reader.ReadLine();
        if (spec == null) return 125;
        string[] parts = spec.Split(' ');
        if (parts.Length != 4 || parts[0] != "spawn") return 125;
        string application, commandLine, cwd;
        try { application = Unbase64(parts[1]); commandLine = Unbase64(parts[2]); cwd = Unbase64(parts[3]); }
        catch { return 125; }

        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) { Say("failed " + Marshal.GetLastWin32Error()); return 126; }
        var limit = new ExtendedLimit();
        limit.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(ExtendedLimit))))
        {
            Say("failed " + Marshal.GetLastWin32Error());
            return 126;
        }

        var startup = new StartupInfo();
        startup.cb = Marshal.SizeOf(typeof(StartupInfo));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(-10);
        startup.hStdOutput = GetStdHandle(-11);
        startup.hStdError = GetStdHandle(-12);
        ProcessInformation info = new ProcessInformation();
        var io = new NamedPipeServerStream[3]; var inherited = new IntPtr[3];
        bool created; int createError = 0;
        try
        {
            if (local)
            {
                string[] kinds = { "stdin", "stdout", "stderr" };
                for (int i = 0; i < 3; i++)
                {
                    io[i] = ConnectLocal(ioChannels[i], token, kinds[i]);
                    if (!DuplicateHandle(GetCurrentProcess(), io[i].SafePipeHandle.DangerousGetHandle(), GetCurrentProcess(), out inherited[i], 0, true, 2))
                        throw new IOException();
                }
                startup.hStdInput = inherited[0]; startup.hStdOutput = inherited[1]; startup.hStdError = inherited[2];
            }
            // SUSPENDED: assignment precedes the provider's first instruction.
            created = CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED,
                IntPtr.Zero, cwd, ref startup, out info);
            if (!created) createError = Marshal.GetLastWin32Error();
        }
        catch { Say("failed local-stdio"); return 125; }
        finally
        {
            for (int i = 0; i < 3; i++) { if (inherited[i] != IntPtr.Zero) CloseHandle(inherited[i]); if (io[i] != null) io[i].Dispose(); }
        }
        if (!created)
        {
            Say("failed " + createError);
            return 127;
        }
        if (!AssignProcessToJobObject(job, info.hProcess))
        {
            int error = Marshal.GetLastWin32Error();
            TerminateProcess(info.hProcess, 1);
            Say("failed " + error);
            return 126;
        }
        uint resumed = ResumeThread(info.hThread);
        if (local && resumed == uint.MaxValue)
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(info.hThread);
            EndTree(job);
            Say("failed " + error);
            return 126;
        }
        CloseHandle(info.hThread);
        Say("started " + info.dwProcessId);

        var killed = new ManualResetEvent(false);
        var listener = new Thread(() =>
        {
            try
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line == "kill") break;
                }
            }
            catch { }
            // A kill, or the client is gone: either way the tree ends.
            killed.Set();
        });
        listener.IsBackground = true;
        listener.Start();

        var exited = new ManualResetEvent(false);
        exited.SafeWaitHandle = new SafeWaitHandle(info.hProcess, false);
        int which = WaitHandle.WaitAny(new WaitHandle[] { exited, killed });

        uint code = 1;
        if (which == 0)
        {
            GetExitCodeProcess(info.hProcess, out code);
            Say("exited " + code);
        }
        Say("empty " + EndTree(job));
        return which == 0 ? (int)code : 1;
    }
}
