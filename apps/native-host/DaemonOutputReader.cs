using System;
using System.Threading.Tasks;

internal static class DaemonOutputReader
{
    public static bool TryReadLine(Task<string> pending, TimeSpan timeout, Action poison, out string line)
    {
        line = null;
        try
        {
            if (!pending.Wait(timeout))
            {
                poison();
                return false;
            }
            line = pending.Result;
            if (!String.IsNullOrWhiteSpace(line)) return true;
        }
        catch { }
        line = null;
        poison();
        return false;
    }
}
