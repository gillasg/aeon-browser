using System;
using System.Threading.Tasks;

internal static class DaemonOutputReaderProbe
{
    private static int Main()
    {
        var pending = new TaskCompletionSource<string>();
        var poisoned = false;
        string line;
        if (DaemonOutputReader.TryReadLine(
            pending.Task, TimeSpan.FromMilliseconds(20), () => poisoned = true, out line)) return 1;
        if (!poisoned || line != null) return 2;

        poisoned = false;
        var complete = new TaskCompletionSource<string>();
        complete.SetResult("c3VjY2Vzcw==");
        if (!DaemonOutputReader.TryReadLine(
            complete.Task, TimeSpan.FromSeconds(1), () => poisoned = true, out line)) return 3;
        if (poisoned || line != "c3VjY2Vzcw==") return 4;

        poisoned = false;
        var failed = new TaskCompletionSource<string>();
        failed.SetException(new InvalidOperationException("synthetic failure"));
        if (DaemonOutputReader.TryReadLine(
            failed.Task, TimeSpan.FromSeconds(1), () => poisoned = true, out line)) return 5;
        if (!poisoned || line != null) return 6;
        return 0;
    }
}
