using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;

internal static class NativeMessagingHost
{
    private const int MaxMessageBytes = 16384;

    public static int Run(string[] args)
    {
        HostConfiguration config;
        try { config = HostConfiguration.Load(); }
        catch { WriteFailure("HOST_CONFIG_INVALID", false); return 0; }

        if (args.Length == 0 || !MatchesOrigin(args[0], config.ExtensionOrigin))
        {
            WriteFailure("ORIGIN_NOT_ALLOWED", false);
            return 0;
        }

        try
        {
            var request = ReadFrame(Console.OpenStandardInput());
            if (request == null) return 0;
            var response = SendToSupervisor(config, args[0], request);
            WriteFrame(Console.OpenStandardOutput(), response);
            return 0;
        }
        catch (InvalidDataException)
        {
            WriteFailure("INVALID_REQUEST", false);
            return 0;
        }
        catch
        {
            WriteFailure("DAEMON_OFFLINE", true);
            return 0;
        }
    }

    public static void WriteFailure(string code, bool retryable)
    {
        var message = "{\"kind\":\"native.bootstrap.result\",\"protocolVersion\":{\"major\":1,\"minor\":1},\"ok\":false,\"code\":\"" + code + "\",\"retryable\":" + (retryable ? "true" : "false") + ",\"supportedProtocolVersion\":{\"major\":1,\"minor\":1}}";
        try { WriteFrame(Console.OpenStandardOutput(), Encoding.UTF8.GetBytes(message)); }
        catch { }
    }

    internal static byte[] ReadFrame(Stream stream)
    {
        var header = ReadExact(stream, 4, true);
        if (header == null) return null;
        var length = BitConverter.ToInt32(header, 0);
        if (length <= 0 || length > MaxMessageBytes)
            throw new InvalidDataException("Native message length is outside its bound.");
        return ReadExact(stream, length, false);
    }

    internal static void WriteFrame(Stream stream, byte[] payload)
    {
        if (payload == null || payload.Length == 0 || payload.Length > MaxMessageBytes)
            throw new InvalidDataException("Native response length is outside its bound.");
        var header = BitConverter.GetBytes(payload.Length);
        stream.Write(header, 0, header.Length);
        stream.Write(payload, 0, payload.Length);
        stream.Flush();
    }

    private static byte[] SendToSupervisor(HostConfiguration config, string origin, byte[] request)
    {
        var serializer = new JavaScriptSerializer { MaxJsonLength = 32768 };
        var envelope = serializer.Serialize(new Dictionary<string, object>
        {
            { "kind", "supervisor.bootstrap" },
            { "origin", "chrome-extension://" + new Uri(origin).Host },
            { "requestBase64", Convert.ToBase64String(request) }
        });
        var bytes = Encoding.UTF8.GetBytes(envelope);
        for (var attempt = 0; attempt < 80; attempt++)
        {
            try
            {
                using (var pipe = new NamedPipeClientStream(".", HostConfiguration.PipeName(), PipeDirection.InOut))
                {
                    pipe.Connect(200);
                    WriteFrame(pipe, bytes);
                    var response = ReadFrame(pipe);
                    if (response == null) throw new IOException("Bootstrap pipe closed without a response.");
                    return response;
                }
            }
            catch (TimeoutException) { }
            catch (IOException) { }
            if (attempt % 5 == 0)
            {
                StartSupervisor();
            }
            System.Threading.Thread.Sleep(200);
        }
        throw new TimeoutException("Daemon bootstrap did not become available.");
    }

    private static void StartSupervisor()
    {
        var start = new ProcessStartInfo
        {
            FileName = Assembly.GetExecutingAssembly().Location,
            Arguments = "--daemon-supervisor",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        Process.Start(start);
    }

    private static bool MatchesOrigin(string received, string expected)
    {
        Uri parsed;
        if (!Uri.TryCreate(received, UriKind.Absolute, out parsed)) return false;
        if (parsed.Scheme != "chrome-extension" || !String.IsNullOrEmpty(parsed.Query) ||
            !String.IsNullOrEmpty(parsed.Fragment) || !String.IsNullOrEmpty(parsed.UserInfo)) return false;
        if (parsed.AbsolutePath != "/" && parsed.AbsolutePath != String.Empty) return false;
        return String.Equals("chrome-extension://" + parsed.Host, expected, StringComparison.Ordinal);
    }

    private static byte[] ReadExact(Stream stream, int length, bool allowCleanEof)
    {
        var result = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = stream.Read(result, offset, length - offset);
            if (read == 0)
            {
                if (allowCleanEof && offset == 0) return null;
                throw new EndOfStreamException("Native message ended before its declared size.");
            }
            offset += read;
        }
        return result;
    }
}
