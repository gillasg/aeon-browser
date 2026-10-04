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
    private static NamedPipeServerStream activePipe;

    public static int Run()
    {
        HostConfiguration config;
        try { config = HostConfiguration.Load(); }
        catch (Exception error) { SupervisorLog.Write("Configuration failed: " + error.Message); return 1; }

        bool created;
        using (var mutex = CreateUserMutex(out created))
        {
            try { if (!mutex.WaitOne(0)) return 0; }
            catch (AbandonedMutexException) { /* This thread owns the recovered mutex. */ }
            while (RunLocked(config) != 0) Thread.Sleep(500);
            return 0;
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
                NativeMessagingHost.ReadFrame(pipe);
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

    private static int RunLocked(HostConfiguration config)
    {
        Process daemon = null;
        IntPtr job = IntPtr.Zero;
        try
        {
            job = CreateKillOnCloseJob();
            daemon = StartDaemon(config);
            if (!AssignProcessToJobObject(job, daemon.Handle))
                throw new InvalidOperationException("Unable to bind the daemon to its supervisor lifetime.");
            daemon.ErrorDataReceived += (sender, eventArgs) => SupervisorLog.Write(eventArgs.Data);
            daemon.BeginErrorReadLine();
            var ready = daemon.StandardOutput.ReadLineAsync();
            if (!ready.Wait(TimeSpan.FromSeconds(20)) || ready.Result != "PIPPIN_DAEMON_READY")
                throw new TimeoutException("Daemon startup did not complete.");
            SupervisorLog.Write("Daemon ready, process " + daemon.Id);
            return ServePipe(config, daemon);
        }
        catch (Exception error) { SupervisorLog.Write("Daemon restarting: " + error.Message); return 1; }
        finally
        {
            if (activePipe != null) activePipe.Dispose();
            if (daemon != null && !daemon.HasExited)
            {
                try { daemon.Kill(); }
                catch { }
            }
            if (job != IntPtr.Zero) CloseHandle(job);
            if (daemon != null) daemon.Dispose();
        }
    }

    private static int ServePipe(HostConfiguration config, Process daemon)
    {
        Task.Run(() =>
        {
            try { daemon.WaitForExit(); }
            catch { }
            SupervisorLog.Write("Daemon exited, code " + daemon.ExitCode);
            var pipe = activePipe;
            if (pipe != null) pipe.Dispose();
        });

        while (!daemon.HasExited)
        {
            try
            {
                using (var pipe = CreateServerPipe())
                {
                    activePipe = pipe;
                    pipe.WaitForConnection();
                    if (daemon.HasExited) break;
                    var request = SupervisorPipe.ReadRequest(pipe);
                    if (request == null) continue;
                    if (IsStopRequest(request))
                    {
                        NativeMessagingHost.WriteFrame(pipe, Encoding.UTF8.GetBytes("{\"kind\":\"supervisor.stopped\"}"));
                        daemon.StandardInput.WriteLine("shutdown");
                        daemon.StandardInput.Flush();
                        if (!daemon.WaitForExit(5000)) daemon.Kill();
                        return 0;
                    }
                    bool restartRequired;
                    var response = ForwardToDaemon(config, daemon, request, out restartRequired);
                    NativeMessagingHost.WriteFrame(pipe, response);
                    if (restartRequired) return 1;
                }
            }
            catch (ObjectDisposedException) { if (daemon.HasExited) break; }
            catch (IOException) { if (daemon.HasExited) break; }
            finally { activePipe = null; }
        }
        return 1;
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
            var pending = daemon.StandardOutput.ReadLineAsync();
            string line;
            if (!DaemonOutputReader.TryReadLine(
                pending, TimeSpan.FromSeconds(15), () => PoisonDaemon(daemon), out line))
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
        start.EnvironmentVariables["PIPPIN_NATIVE_DATA_DIR"] = config.DataDirectory;
        start.EnvironmentVariables["PIPPIN_NATIVE_EXTENSION_ORIGIN"] = config.ExtensionOrigin;
        start.EnvironmentVariables["PIPPIN_NATIVE_SUPERVISED"] = "1";
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
