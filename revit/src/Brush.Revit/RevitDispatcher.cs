using System.Collections.Concurrent;
using Autodesk.Revit.UI;
using Brush.Revit.Plugins;

namespace Brush.Revit;

/// <summary>
/// Runs work on Revit's API thread. The link server lives on thread-pool threads, and the Revit API may only be
/// called from Revit's own context, so every host call is queued here and executed from an <see cref="ExternalEvent"/>,
/// which Revit raises when it is idle (not while a modal dialog or another command is running).
/// </summary>
///
/// It lives in the shim for the whole Revit session: Revit keeps the handler, so a hot-reloaded plugin could never be
/// unloaded if it owned one.
public sealed class RevitDispatcher : IExternalEventHandler
{
    private readonly ConcurrentQueue<Action<UIApplication>> queue = new();
    private readonly ExternalEvent externalEvent;
    private readonly IBrushLog log;

    /// <summary>Must be created in a Revit API context (OnStartup is one).</summary>
    internal RevitDispatcher(IBrushLog log)
    {
        this.log = log;
        externalEvent = ExternalEvent.Create(this);
    }

    public Task<T> InvokeAsync<T>(Func<UIApplication, T> work, CancellationToken ct = default)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var reg = ct.Register(() => tcs.TrySetCanceled(ct));
        queue.Enqueue(app =>
        {
            reg.Dispose();
            if (tcs.Task.IsCompleted) return;
            try
            {
                tcs.TrySetResult(work(app));
            }
            catch (Exception e)
            {
                tcs.TrySetException(e);
            }
        });
        var r = externalEvent.Raise();
        if (r is ExternalEventRequest.Denied or ExternalEventRequest.TimedOut)
            tcs.TrySetException(new InvalidOperationException($"Revit refused the request ({r}); try again when Revit is idle"));
        return tcs.Task;
    }

    public void Execute(UIApplication app)
    {
        // Drain everything queued so far; anything queued while we run raises the event again.
        while (queue.TryDequeue(out var work))
        {
            // Work items complete their own task, but an escape here would make Revit show its own error dialog.
            try
            {
                work(app);
            }
            catch (Exception e)
            {
                log.Error("unhandled error on the Revit thread", e);
            }
        }
    }

    public string GetName() => "Brush Link";

    public void Dispose() => externalEvent.Dispose();
}
