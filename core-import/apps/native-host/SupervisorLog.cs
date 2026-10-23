using System;
using System.IO;
internal static class SupervisorLog
{
    private static readonly object Gate = new object();
    public static void Write(string message)
    {
        if (String.IsNullOrEmpty(message)) return;
        try
        {
            lock (Gate)
            {
                var path = Path.Combine(Path.GetDirectoryName(HostConfiguration.ConfigPath), "daemon-supervisor.log");
                if (File.Exists(path) && new FileInfo(path).Length > 262144)
                {
                    var previous = path + ".previous";
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(path, previous);
                }
                File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " " + message.Substring(0, Math.Min(message.Length, 2000)) + Environment.NewLine);
            }
        }
        catch { }
    }
}
