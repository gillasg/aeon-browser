using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class DaemonSupervisor
{
    private const int MaxMessageBytes = 16384;
    /// <summary>One startup phase may stall this long before the daemon is replaced.</summary>
    private const int PhaseTimeoutSeconds = 90;

    private enum Outcome { Stopped, Crashed, NeverStarted }

    public static int Run()
    {
        HostConfiguration config;
        try { config = HostConfiguration.Load(); }
        catch (Exception error) { SupervisorLog.Write("Configuration failed: " + error.Message); return 1; }

        bool created;
        using (var mutex = CreateUserMutex(out created))
        {
            try
            {
                if (!mutex.WaitOne(0))
                {
                    SupervisorLog.Write("Another supervisor already owns the daemon.");
                    return 0;
                }
            }
            catch (AbandonedMutexException) { /* This thread owns the recovered mutex. */ }
            SupervisorStatus.Initialize();
            SupervisorLog.Write("Supervisor started, process " + Process.GetCurrentProcess().Id);
            try { return RestartForever(config); }
            finally
            {
                SupervisorStatus.Clear();
                SupervisorLog.Write("Supervisor stopped.");
            }
        }
    }

    public static int Stop()
    {
        try
        {
            using (var pipe = new NamedPipeClientStream(".", HostConfiguration.PipeName(), PipeDirection.InOut))
            {
                pipe.Connect(1500);
                NativeMessagingHost.WriteFrame(pipe, Encoding.UTF8.GetBytes("{\"kind\":\"supervisor.stop\"}"));
                // A wedged supervisor never answers, so a stop request must not wait for it.
                var pending = Task.Run(() => NativeMessagingHost.ReadFrame(pipe));
                if (!pending.Wait(TimeSpan.FromSeconds(3)))
                {
                    pending.ContinueWith(task => { var ignored = task.Exception; },
                        TaskContinuationOptions.OnlyOnFaulted);
                    pipe.Dispose();
                    return 1;
                }
            }
            return 0;
        }
        catch { return 1; }
    }

    public static int PrintPipeAcl()
    {
        using (var pipe = CreateServerPipe())
        {
            var security = pipe.GetAccessControl();
            Console.Out.WriteLine(security.GetSecurityDescriptorSddlForm(AccessControlSections.All));
            return 0;
        }
    }

    /// <summary>
    /// The daemon is one restartable child, so this loop never exits on its own: a daemon that
    /// crashes after serving gets an immediate restart, and one that never starts backs off.
    /// </summary>
    private static int RestartForever(HostConfiguration config)
    {
        var failures = 0;
        while (true)
        {
            var outcome = RunLocked(config);
            if (outcome == Outcome.Stopped) return 0;
            failures = outcome == Outcome.Crashed ? 0 : failures + 1;
            var delay = failures == 0
                ? 1000
                : (int)Math.Min(30000, 500 * (1 << Math.Min(failures, 6)));
            SupervisorLog.Write("Daemon restart in " + delay + "ms.");
            Thread.Sleep(delay);
        }
    }

    private static Outcome RunLocked(HostConfiguration config)
    {
        Process daemon = null;
        IntPtr job = IntPtr.Zero;
        try
        {
            job = CreateKillOnCloseJob();
            SupervisorStatus.SetPhase("spawn");
            daemon = StartDaemon(config);
            if (!AssignProcessToJobObject(job, daemon.Handle))
                throw new InvalidOperationException("Unable to bind the daemon to its supervisor lifetime.");
            daemon.ErrorDataReceived += (sender, eventArgs) => SupervisorLog.Write(eventArgs.Data);
            daemon.BeginErrorReadLine();
            WaitForDaemonReady(daemon);
            SupervisorStatus.SetReady(daemon.Id);
            SupervisorLog.Write("Daemon ready, process " + daemon.Id);
            return ServePipe(config, daemon) == 0 ? Outcome.Stopped : Outcome.Crashed;
        }
        catch (Exception error)
        {
            SupervisorLog.Write("Daemon restarting: " + error);
            return Outcome.NeverStarted;
        }
        finally
        {
            if (daemon != null && !daemon.HasExited)
            {
                try { daemon.Kill(); }
                catch { }
                // Give the job time to reclaim anything the daemon spawned before it is closed.
                try { daemon.WaitForExit(5000); }
                catch { }
            }
            if (job != IntPtr.Zero) CloseHandle(job);
            if (daemon != null) daemon.Dispose();
        }
    }

    /// <summary>
    /// Readiness is judged per phase: a slow cold start that keeps moving is never killed,
    /// while one stuck inside a single phase is replaced.
    /// </summary>
    private static void WaitForDaemonReady(Process daemon)
    {
        var phase = "spawn";
        var deadline = DateTime.UtcNow.AddSeconds(PhaseTimeoutSeconds);
        var pending = daemon.StandardOutput.ReadLineAsync();
        while (true)
        {
            if (pending.Wait(250))
            {
                var line = pending.Result;
                if (line == null)
                    throw new InvalidOperationException(
                        "Daemon output closed during " + phase + ", code " + ExitCodeOf(daemon) + ".");
                if (line == "AEON_DAEMON_READY") return;
                var marker = PhaseOf(line);
                if (marker != null)
                {
                    phase = marker;
                    deadline = DateTime.UtcNow.AddSeconds(PhaseTimeoutSeconds);
                    SupervisorStatus.SetPhase(phase);
                    SupervisorLog.Write("Daemon phase " + phase);
                }
                pending = daemon.StandardOutput.ReadLineAsync();
                continue;
            }
            if (daemon.HasExited)
                throw new InvalidOperationException(
                    "Daemon exited during " + phase + ", code " + ExitCodeOf(daemon) + ".");
            if (DateTime.UtcNow > deadline)
                throw new TimeoutException("Daemon startup stalled during " + phase + ".");
        }
    }

    private static int ServePipe(HostConfiguration config, Process daemon)
    {
        Task.Run(() =>
        {
            try { daemon.WaitForExit(); }
            catch { }
            SupervisorLog.Write("Daemon exited, code " + ExitCodeOf(daemon));
            SupervisorStatus.SetRestarting("daemon-exited");
        });

        // One server pipe per daemon lifetime: a pending accept is cancelled rather than
        // disposed, because a disposed pipe with a pending accept keeps its name reserved.
        using (var pipe = CreateServerPipe())
        {
            while (!daemon.HasExited)
            {
                if (!WaitForClient(pipe, daemon)) break;
                var restartRequired = false;
                try
                {
                    var request = SupervisorPipe.ReadRequest(pipe);
                    if (request != null)
                    {
                        if (IsStopRequest(request))
                        {
                            NativeMessagingHost.WriteFrame(pipe, Encoding.UTF8.GetBytes("{\"kind\":\"supervisor.stopped\"}"));
                            daemon.StandardInput.WriteLine("shutdown");
                            daemon.StandardInput.Flush();
                            if (!daemon.WaitForExit(5000)) daemon.Kill();
                            return 0;
                        }
                        var response = ForwardToDaemon(config, daemon, request, out restartRequired);
                        NativeMessagingHost.WriteFrame(pipe, response);
                    }
                }
                catch (IOException) { if (daemon.HasExited) break; }
                finally
                {
                    try { pipe.Disconnect(); }
                    catch { }
                }
                if (restartRequired) return 1;
            }
        }
        return 1;
    }

    /// <summary>
    /// A cancelled accept keeps its handle and name; a disposed one does not. That distinction
    /// is what lets the supervisor survive a dead daemon and serve the next one.
    /// </summary>
    private static bool WaitForClient(NamedPipeServerStream pipe, Process daemon)
    {
        while (!daemon.HasExited)
        {
            using (var cancellation = new CancellationTokenSource())
            {
                Task waiting;
                try { waiting = pipe.WaitForConnectionAsync(cancellation.Token); }
                catch (Exception) { return false; }
                while (!waiting.Wait(500))
                {
                    if (!daemon.HasExited) continue;
                    cancellation.Cancel();
                    try { waiting.Wait(TimeSpan.FromSeconds(5)); }
                    catch { }
                    return false;
                }
                try { waiting.Wait(); return true; }
                catch (AggregateException) { if (daemon.HasExited) return false; }
            }
        }
        return false;
    }

    private static byte[] ForwardToDaemon(
        HostConfiguration config, Process daemon, byte[] envelopeBytes, out bool restartRequired)
    {
        restartRequired = false;
        var serializer = new JavaScriptSerializer { MaxJsonLength = 32768, RecursionLimit = 8 };
        var envelope = serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(envelopeBytes));
        if (envelope == null || envelope.Count != 3 ||
            !envelope.ContainsKey("kind") || !envelope.ContainsKey("origin") || !envelope.ContainsKey("requestBase64") ||
            !String.Equals(envelope["kind"] as string, "supervisor.bootstrap", StringComparison.Ordinal) ||
            !String.Equals(envelope["origin"] as string, config.ExtensionOrigin, StringComparison.Ordinal))
            return Failure("ORIGIN_NOT_ALLOWED", false);

        byte[] request;
        try { request = Convert.FromBase64String(envelope["requestBase64"] as string); }
        catch { return Failure("INVALID_REQUEST", false); }
        if (request.Length == 0 || request.Length > MaxMessageBytes) return Failure("INVALID_REQUEST", false);

        try
        {
            daemon.StandardInput.WriteLine(Convert.ToBase64String(envelopeBytes));
            daemon.StandardInput.Flush();
            var line = ReadDaemonReply(daemon);
            if (line == null)
            {
                restartRequired = true;
                return Failure("DAEMON_OFFLINE", true);
            }
            var response = Convert.FromBase64String(line);
            if (response.Length == 0 || response.Length > MaxMessageBytes)
            {
                PoisonDaemon(daemon);
                restartRequired = true;
                return Failure("BOOTSTRAP_UNAVAILABLE", true);
            }
            return response;
        }
        catch
        {
            PoisonDaemon(daemon);
            restartRequired = true;
            return Failure("BOOTSTRAP_UNAVAILABLE", true);
        }
    }

    /// <summary>One reply line, skipping any progress marker the daemon still has in flight.</summary>
    private static string ReadDaemonReply(Process daemon)
    {
        var pending = daemon.StandardOutput.ReadLineAsync();
        for (var attempt = 0; attempt < 20; attempt++)
        {
            string line;
            if (!DaemonOutputReader.TryReadLine(
                pending, TimeSpan.FromSeconds(15), () => PoisonDaemon(daemon), out line))
                return null;
            if (PhaseOf(line) == null) return line;
            pending = daemon.StandardOutput.ReadLineAsync();
        }
        return null;
    }

    private static string PhaseOf(string line)
    {
        const string marker = "AEON_DAEMON_PHASE ";
        if (line == null || !line.StartsWith(marker, StringComparison.Ordinal)) return null;
        return line.Substring(marker.Length).Trim();
    }

    private static string ExitCodeOf(Process daemon)
    {
        try { return daemon.HasExited ? daemon.ExitCode.ToString() : "running"; }
        catch { return "unknown"; }
    }

    private static void PoisonDaemon(Process daemon)
    {
        try { if (!daemon.HasExited) daemon.Kill(); }
        catch { }
    }

    private static NamedPipeServerStream CreateServerPipe()
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(
            HostConfiguration.CurrentUserSid(),
            PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance,
            AccessControlType.Allow));
        return new NamedPipeServerStream(
            HostConfiguration.PipeName(), PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.None, MaxMessageBytes, MaxMessageBytes, security);
    }

    private static Mutex CreateUserMutex(out bool created)
    {
        var security = new MutexSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new MutexAccessRule(
            HostConfiguration.CurrentUserSid(), MutexRights.FullControl, AccessControlType.Allow));
        return new Mutex(false, HostConfiguration.MutexName(), out created, security);
    }

    private static Process StartDaemon(HostConfiguration config)
    {
        var start = new ProcessStartInfo
        {
            FileName = config.NodeExecutable,
            Arguments = Quote(config.DaemonEntrypoint) + " --managed-daemon",
            WorkingDirectory = config.DataDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.EnvironmentVariables["AEON_NATIVE_DATA_DIR"] = config.DataDirectory;
        start.EnvironmentVariables["AEON_NATIVE_EXTENSION_ORIGIN"] = config.ExtensionOrigin;
        start.EnvironmentVariables["AEON_NATIVE_SUPERVISED"] = "1";
        var process = Process.Start(start);
        if (process == null) throw new InvalidOperationException("The daemon process did not start.");
        return process;
    }

    private static bool IsStopRequest(byte[] request)
    {
        var serializer = new JavaScriptSerializer { MaxJsonLength = 128, RecursionLimit = 2 };
        try
        {
            var value = serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(request));
            return value != null && value.Count == 1 &&
                String.Equals(value["kind"] as string, "supervisor.stop", StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private static byte[] Failure(string code, bool retryable)
    {
        var json = "{\"kind\":\"native.bootstrap.result\",\"protocolVersion\":{\"major\":1,\"minor\":1},\"ok\":false,\"code\":\"" + code + "\",\"retryable\":" + (retryable ? "true" : "false") + ",\"supportedProtocolVersion\":{\"major\":1,\"minor\":1}}";
        return Encoding.UTF8.GetBytes(json);
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        var handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new InvalidOperationException("Could not create daemon lifetime job.");
        var limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = 0x00002000;
        var size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        var memory = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, memory, false);
            if (!SetInformationJobObject(handle, 9, memory, (uint)size))
                throw new InvalidOperationException("Could not set daemon lifetime job policy.");
        }
        catch { CloseHandle(handle); throw; }
        finally { Marshal.FreeHGlobal(memory); }
        return handle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
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
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
