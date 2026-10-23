using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

/// <summary>
/// Progress file the daemon launcher reads to tell a working supervisor from a wedged one.
/// It is best-effort: every write failure is ignored and never affects the daemon.
/// </summary>
internal static class SupervisorStatus
{
    private static readonly object Gate = new object();
    private static readonly JavaScriptSerializer Serializer =
        new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 4 };
    private static string path;
    private static int supervisorPid;
    private static string startedAt = "";
    private static string state = "starting";
    private static string phase = "spawn";
    private static int daemonPid;
    private static int restarts;

    public static void Initialize()
    {
        lock (Gate)
        {
            path = Path.Combine(
                Path.GetDirectoryName(HostConfiguration.ConfigPath), "daemon-supervisor-status.json");
            supervisorPid = Process.GetCurrentProcess().Id;
            startedAt = Now();
            state = "starting";
            phase = "spawn";
            daemonPid = 0;
            restarts = 0;
            WriteLocked();
        }
    }

    /// <summary>A startup phase advanced, so the supervisor is still making progress.</summary>
    public static void SetPhase(string value)
    {
        lock (Gate)
        {
            state = "starting";
            phase = value ?? "";
            WriteLocked();
        }
    }

    public static void SetReady(int pid)
    {
        lock (Gate)
        {
            state = "ready";
            phase = "";
            daemonPid = pid;
            WriteLocked();
        }
    }

    public static void SetRestarting(string reason)
    {
        lock (Gate)
        {
            state = "restarting";
            phase = reason ?? "";
            daemonPid = 0;
            restarts++;
            WriteLocked();
        }
    }

    public static void Clear()
    {
        lock (Gate)
        {
            try
            {
                if (path != null && File.Exists(path)) File.Delete(path);
            }
            catch { }
        }
    }

    private static void WriteLocked()
    {
        if (path == null) return;
        try
        {
            var json = Serializer.Serialize(new System.Collections.Generic.Dictionary<string, object>
            {
                { "kind", "daemon-supervisor.status" },
                { "supervisorPid", supervisorPid },
                { "daemonPid", daemonPid },
                { "state", state },
                { "phase", phase },
                { "startedAt", startedAt },
                { "updatedAt", Now() },
                { "restarts", restarts }
            });
            var temporary = path + ".tmp";
            File.WriteAllText(temporary, json);
            if (File.Exists(path))
            {
                try { File.Replace(temporary, path, null); return; }
                catch { File.Delete(path); }
            }
            File.Move(temporary, path);
        }
        catch { }
    }

    private static string Now()
    {
        return DateTime.UtcNow.ToString("o");
    }
}
