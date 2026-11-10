using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal sealed class HostConfiguration
{
    public string ExtensionId;
    public string NodeExecutable;
    public string DaemonEntrypoint;
    public string DataDirectory;
    // Optional release-train fields. The daemon still starts from DaemonEntrypoint.
    public string Current;
    public string Previous;
    public string Channel;

    public string ExtensionOrigin { get { return "chrome-extension://" + ExtensionId; } }

    public static string ConfigPath
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Aeon", "host-config.json");
        }
    }

    public static HostConfiguration Load()
    {
        return Load(ConfigPath);
    }

    internal static HostConfiguration Load(string path)
    {
        for (var attempt = 0; ; attempt++)
        {
            try { return ReadConfiguration(path); }
            catch (Exception error)
            {
                if (attempt >= 5) throw;
                if (!(error is IOException) && !(error is InvalidDataException) && !(error is ArgumentException) &&
                    !(error is InvalidOperationException)) throw;
                System.Threading.Thread.Sleep(100);
            }
        }
    }

    private static HostConfiguration ReadConfiguration(string path)
    {
        var file = new FileInfo(path);
        if (!file.Exists || file.Length < 2 || file.Length > 16384)
            throw new InvalidDataException("Native host config is missing or too large.");
        var serializer = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 8 };
        string text;
        using (var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete))
        using (var reader = new StreamReader(stream)) text = reader.ReadToEnd();
        var values = serializer.Deserialize<Dictionary<string, object>>(text);
        if (!SupportedShape(values))
            throw new InvalidDataException("Native host config has an unsupported shape.");

        var result = new HostConfiguration
        {
            ExtensionId = ReadString(values, "extensionId"),
            NodeExecutable = ReadString(values, "nodeExecutable"),
            DaemonEntrypoint = ReadString(values, "daemonEntrypoint"),
            DataDirectory = ReadString(values, "dataDirectory"),
            Current = ReadOptional(values, "current"),
            Previous = ReadOptional(values, "previous"),
            Channel = ReadOptional(values, "channel")
        };
        result.Validate();
        return result;
    }

    public void Validate()
    {
        if (!Regex.IsMatch(ExtensionId, "^[a-p]{32}$"))
            throw new InvalidDataException("Native host config has an invalid extension ID.");
        NodeExecutable = ExistingFile(NodeExecutable);
        DaemonEntrypoint = ExistingEntrypoint(DaemonEntrypoint);
        var localAppData = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        var appDataRoot = Path.GetFullPath(Path.Combine(localAppData, "Aeon")) + Path.DirectorySeparatorChar;
        DataDirectory = Path.GetFullPath(DataDirectory);
        if (!DataDirectory.StartsWith(appDataRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Daemon data must live under the user-local Aeon data directory.");
        Directory.CreateDirectory(DataDirectory);
    }

    public static string PipeName()
    {
        return "aeon-bootstrap-" + UserHash();
    }

    public static string MutexName()
    {
        return "Global\\Aeon-Daemon-" + UserHash();
    }

    public static SecurityIdentifier CurrentUserSid()
    {
        using (var identity = WindowsIdentity.GetCurrent())
        {
            if (identity.User == null) throw new InvalidOperationException("Current user SID is unavailable.");
            return identity.User;
        }
    }

    private static string UserHash()
    {
        using (var sha = SHA256.Create())
        {
            var digest = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(CurrentUserSid().Value));
            return BitConverter.ToString(digest, 0, 12).Replace("-", "").ToLowerInvariant();
        }
    }

    private static bool SupportedShape(Dictionary<string, object> values)
    {
        if (values == null || !values.ContainsKey("extensionId") || !values.ContainsKey("nodeExecutable") ||
            !values.ContainsKey("daemonEntrypoint") || !values.ContainsKey("dataDirectory"))
            return false;
        foreach (var key in values.Keys)
            if (!KnownKey(key)) return false;
        return true;
    }

    private static bool KnownKey(string key)
    {
        return key == "extensionId" || key == "nodeExecutable" || key == "daemonEntrypoint" ||
            key == "dataDirectory" || key == "current" || key == "previous" || key == "channel";
    }

    private static string ReadOptional(IDictionary<string, object> values, string key)
    {
        if (!values.ContainsKey(key)) return null;
        return ReadString(values, key);
    }

    private static string ReadString(IDictionary<string, object> values, string key)
    {
        var value = values[key] as string;
        if (String.IsNullOrWhiteSpace(value)) throw new InvalidDataException("Native host config has an invalid path or ID.");
        return value;
    }

    private static string ExistingFile(string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (!File.Exists(fullPath)) throw new FileNotFoundException("A configured native host file is missing.");
        return fullPath;
    }

    /// <summary>
    /// A versioned build may be the daemon file or its directory. The directory form launches main.js inside it.
    /// </summary>
    private static string ExistingEntrypoint(string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (File.Exists(fullPath)) return fullPath;
        var nested = Path.Combine(fullPath, "main.js");
        if (Directory.Exists(fullPath) && File.Exists(nested)) return Path.GetFullPath(nested);
        throw new FileNotFoundException("A configured native host file is missing.");
    }
}
