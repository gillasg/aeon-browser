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

    public string ExtensionOrigin { get { return "chrome-extension://" + ExtensionId; } }

    public static string ConfigPath
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Pippin", "Slice3Dev", "host-config.json");
        }
    }

    public static HostConfiguration Load()
    {
        var file = new FileInfo(ConfigPath);
        if (!file.Exists || file.Length < 2 || file.Length > 16384)
            throw new InvalidDataException("Native host config is missing or too large.");
        var serializer = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 8 };
        var values = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(file.FullName));
        if (values == null || values.Count != 4 ||
            !values.ContainsKey("extensionId") || !values.ContainsKey("nodeExecutable") ||
            !values.ContainsKey("daemonEntrypoint") || !values.ContainsKey("dataDirectory"))
            throw new InvalidDataException("Native host config has an unsupported shape.");

        var result = new HostConfiguration
        {
            ExtensionId = ReadString(values, "extensionId"),
            NodeExecutable = ReadString(values, "nodeExecutable"),
            DaemonEntrypoint = ReadString(values, "daemonEntrypoint"),
            DataDirectory = ReadString(values, "dataDirectory")
        };
        result.Validate();
        return result;
    }

    public void Validate()
    {
        if (!Regex.IsMatch(ExtensionId, "^[a-p]{32}$"))
            throw new InvalidDataException("Native host config has an invalid extension ID.");
        NodeExecutable = ExistingFile(NodeExecutable);
        DaemonEntrypoint = ExistingFile(DaemonEntrypoint);
        var localAppData = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        var appDataRoot = Path.GetFullPath(Path.Combine(localAppData, "Pippin")) + Path.DirectorySeparatorChar;
        DataDirectory = Path.GetFullPath(DataDirectory);
        if (!DataDirectory.StartsWith(appDataRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Daemon data must live under the user-local Pippin data directory.");
        Directory.CreateDirectory(DataDirectory);
    }

    public static string PipeName()
    {
        return "pippin-bootstrap-" + UserHash();
    }

    public static string MutexName()
    {
        return "Global\\Pippin-Daemon-" + UserHash();
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
}
