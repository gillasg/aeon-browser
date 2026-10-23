using System;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "--daemon-supervisor")
                return DaemonSupervisor.Run();
            if (args.Length > 0 && args[0] == "--stop-supervisor")
                return DaemonSupervisor.Stop();
            if (args.Length > 0 && args[0] == "--inspect-pipe-acl")
                return DaemonSupervisor.PrintPipeAcl();
            return NativeMessagingHost.Run(args);
        }
        catch
        {
            NativeMessagingHost.WriteFailure("BOOTSTRAP_UNAVAILABLE", true);
            return 1;
        }
    }
}
