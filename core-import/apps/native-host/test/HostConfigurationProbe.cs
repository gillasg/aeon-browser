using System;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;
internal static class HostConfigurationProbe
{
    public static int Main(string[] args)
    {
        var root = args[0];
        var path = Path.Combine(root, "config.json");
        var executable = Path.Combine(root, "node.exe");
        var entry = Path.Combine(root, "main.js");
        File.WriteAllText(executable, "fixture");
        File.WriteAllText(entry, "fixture");
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Aeon", "configuration-probe-" + Guid.NewGuid().ToString("N"));
        try
        {
            var json = new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                { "extensionId", new string('a', 32) }, { "nodeExecutable", executable },
                { "daemonEntrypoint", entry }, { "dataDirectory", data }
            });
            File.WriteAllText(path, "");
            var writer = new Thread(() => { Thread.Sleep(150); File.WriteAllText(path, json); });
            writer.Start();
            var config = HostConfiguration.Load(path);
            writer.Join();
            if (config.DaemonEntrypoint != Path.GetFullPath(entry)) throw new Exception("Transient read did not recover");
            File.WriteAllText(path, "{}");
            try { HostConfiguration.Load(path); throw new Exception("Invalid configuration accepted"); }
            catch (InvalidDataException) { }
            File.WriteAllText(path, json);
            File.Delete(entry);
            try { HostConfiguration.Load(path); throw new Exception("Missing entrypoint accepted"); }
            catch (FileNotFoundException) { }
            Console.WriteLine("Configuration recovery and validation passed");
            return 0;
        }
        finally { if (Directory.Exists(data)) Directory.Delete(data, true); }
    }
}
