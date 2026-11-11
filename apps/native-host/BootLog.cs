using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

// Parent process tree and the disk queue, stamped around a daemon start. The first disk sample
// can be 0; nothing waits for a second sample.
internal static class BootLog
{
    public static string Context()
    {
        return "parents=" + Parents() + " diskQueue=" + DiskQueue();
    }

    private static string Parents()
    {
        try
        {
            var names = "";
            var pid = Process.GetCurrentProcess().Id;
            for (var depth = 0; depth < 6 && pid > 0; depth++)
            {
                Process process;
                try { process = Process.GetProcessById(pid); }
                catch { break; }
                if (names.Length > 0) names += " <- ";
                names += process.ProcessName + ":" + pid;
                pid = ParentOf(process);
            }
            return names.Length == 0 ? "unknown" : names;
        }
        catch (Exception error) { return "unknown (" + error.GetType().Name + ")"; }
    }

    private static int ParentOf(Process process)
    {
        var info = new ProcessBasicInformation();
        int size;
        var status = NtQueryInformationProcess(process.Handle, 0, ref info, Marshal.SizeOf(info), out size);
        if (status != 0) return 0;
        return info.InheritedFromUniqueProcessId.ToInt32();
    }

    // The first sample can block while the counter category loads. Read it off the spawn path
    // so StartWithin is not stuck before the process starts. Later log lines see the value.
    private static int diskStarted;
    private static string diskQueue = "pending";

    private static string DiskQueue()
    {
        if (Interlocked.CompareExchange(ref diskStarted, 1, 0) == 0)
            ThreadPool.QueueUserWorkItem(_ => { diskQueue = ReadDiskQueue(); });
        return diskQueue;
    }

    private static string ReadDiskQueue()
    {
        try
        {
            using (var counter = new PerformanceCounter("PhysicalDisk", "Current Disk Queue Length", "_Total"))
                return counter.NextValue().ToString("0.00", CultureInfo.InvariantCulture);
        }
        catch (Exception error) { return "unknown (" + error.GetType().Name + ")"; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr process, int infoClass, ref ProcessBasicInformation info, int length, out int returned);
}
