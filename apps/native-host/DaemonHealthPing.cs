using System;
using System.IO;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

// core.ping on the daemon's WebSocket. The event loop has to answer it; a blocked loop still
// accepts TCP. The supervisor logs this beside the stdout probe. The kill decision stays on
// that probe.
internal static class DaemonHealthPing
{
    public static bool Try(HostConfiguration config)
    {
        try
        {
            var path = Path.Combine(config.DataDirectory, "core-connection.json");
            if (!File.Exists(path)) return false;
            var text = File.ReadAllText(path);
            var match = Regex.Match(text, "ws://127\\.0\\.0\\.1:(\\d+)/core/v1");
            if (!match.Success) return false;
            return Ping(int.Parse(match.Groups[1].Value));
        }
        catch { return false; }
    }

    private static bool Ping(int port)
    {
        using (var client = new TcpClient())
        {
            if (!client.ConnectAsync("127.0.0.1", port).Wait(2000)) return false;
            client.ReceiveTimeout = 2000;
            client.SendTimeout = 2000;
            var stream = client.GetStream();
            var key = Convert.ToBase64String(Guid.NewGuid().ToByteArray());
            var head = Encoding.ASCII.GetBytes(
                "GET /core/v1 HTTP/1.1\r\nHost: 127.0.0.1:" + port +
                "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
                "\r\nSec-WebSocket-Version: 13\r\n\r\n");
            stream.Write(head, 0, head.Length);
            var buffer = new byte[1024];
            var read = stream.Read(buffer, 0, buffer.Length);
            if (Encoding.ASCII.GetString(buffer, 0, read).IndexOf("101", StringComparison.Ordinal) < 0) return false;
            var id = Guid.NewGuid().ToString();
            var payload = Encoding.UTF8.GetBytes("{\"kind\":\"core.ping\",\"requestId\":\"" + id + "\"}");
            var frame = Frame(payload);
            stream.Write(frame, 0, frame.Length);
            read = stream.Read(buffer, 0, buffer.Length);
            return Encoding.UTF8.GetString(buffer, 0, read).IndexOf("core.ping.result", StringComparison.Ordinal) >= 0;
        }
    }

    private static byte[] Frame(byte[] payload)
    {
        var mask = new byte[4];
        using (var random = RandomNumberGenerator.Create()) random.GetBytes(mask);
        var frame = new byte[6 + payload.Length];
        frame[0] = 0x81;
        frame[1] = (byte)(0x80 | payload.Length);
        Buffer.BlockCopy(mask, 0, frame, 2, 4);
        for (var i = 0; i < payload.Length; i++) frame[6 + i] = (byte)(payload[i] ^ mask[i % 4]);
        return frame;
    }
}
