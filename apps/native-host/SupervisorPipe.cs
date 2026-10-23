using System;
using System.IO;
using System.IO.Pipes;
using System.Threading.Tasks;

internal static class SupervisorPipe
{
    // A disconnected or incomplete bootstrap client must not block all future clients.
    public static byte[] ReadRequest(NamedPipeServerStream pipe)
    {
        var pending = Task.Run(() => NativeMessagingHost.ReadFrame(pipe));
        try
        {
            if (pending.Wait(TimeSpan.FromSeconds(5))) return pending.Result;
            // The caller disconnects the pipe, which also ends the pending read.
            pending.ContinueWith(task => { var ignored = task.Exception; },
                TaskContinuationOptions.OnlyOnFaulted);
            throw new IOException("Bootstrap client did not finish its request.");
        }
        catch (AggregateException error)
        {
            throw new IOException("Bootstrap client disconnected.", error.InnerException);
        }
    }
}
