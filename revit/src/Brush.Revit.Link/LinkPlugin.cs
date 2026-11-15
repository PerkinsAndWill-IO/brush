using System.Net.Sockets;
using Autodesk.Revit.UI;
using Brush.Link.Server;
using Brush.Revit.Plugins;

namespace Brush.Revit;

/// <summary>
/// The hot-reloadable plugin: starts the live link (unless <c>autoStart</c> is false in the settings file) and answers
/// the "Brush Link" ribbon button, which shows the link status and turns it on or off. A new copy of this class is
/// created after every rebuild; <see cref="Dispose"/> must undo everything <see cref="Start"/> did.
/// </summary>
public sealed class LinkPlugin : IBrushPlugin
{
    private BrushPluginContext? ctx;
    private ILinkLog log = NullLinkLog.Instance;
    private RevitHost? host;
    private LinkServer? server;
    private string? lastError;

    public void Start(BrushPluginContext context)
    {
        ctx = context;
        log = new PluginLog(context.Log, context.Generation);
        host = new RevitHost(context.Dispatcher, context.Ui, log, context.SettingsPath, context.State);
        // After a hot reload, bring the link back if it was on (whatever autoStart says); otherwise follow the settings.
        var wasOn = context.State.TryGetValue(StateKeys.LinkOn, out var on) ? (bool)on : LoadOptions().AutoStart;
        if (wasOn) StartLink();
    }

    public void Dispose()
    {
        // Remember whether the link was on, so the next copy comes back the same way. Not on Revit shutdown, where
        // nothing reads it.
        if (ctx is not null) ctx.State[StateKeys.LinkOn] = server is not null;
        StopLink(remember: false);
        host?.Dispose();
        host = null;
    }

    public void OnRibbonButton(UIApplication app)
    {
        var running = server is not null;
        var reloadNote = $"Plugin #{ctx?.Generation} from {ctx?.LoadedFrom}";
        var dlg = new TaskDialog("Brush Link")
        {
            MainInstruction = running ? "The Brush Editor link is on" : "The Brush Editor link is off",
            MainContent = (running
                ? $"Editors connect to {server!.Url}\nConnected editors: {server.Hub.ConnectionCount}"
                : lastError ?? "Turn it on to let the Brush Editor apply its edits to this model.")
                + $"\n\nSettings: {ctx?.SettingsPath}\n{reloadNote}",
            CommonButtons = TaskDialogCommonButtons.Close,
        };
        dlg.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, running ? "Turn the link off" : "Turn the link on");
        dlg.AddCommandLink(TaskDialogCommandLinkId.CommandLink2, "Reload the plugin", "Load Brush.Revit.Link.dll again from disk");
        switch (dlg.Show())
        {
            case TaskDialogResult.CommandLink1 when running:
                StopLink(remember: true);
                break;
            case TaskDialogResult.CommandLink1:
                if (!StartLink()) TaskDialog.Show("Brush Link", lastError ?? "Could not start the link.");
                break;
            case TaskDialogResult.CommandLink2:
                ctx?.RequestReload();
                break;
        }
    }

    private RevitLinkOptions LoadOptions()
    {
        var path = ctx!.SettingsPath;
        try
        {
            return RevitLinkOptions.Load(path);
        }
        catch (Exception e)
        {
            log.Error($"bad settings file {path}, using defaults", e);
            return new RevitLinkOptions();
        }
    }

    private bool StartLink()
    {
        if (server is not null) return true;
        var options = LoadOptions();
        try
        {
            var s = new LinkServer(host!, options.Link, log);
            s.Start();
            server = s;
            lastError = null;
            ctx!.State[StateKeys.LinkOn] = true;
            return true;
        }
        catch (SocketException e)
        {
            // Usually a second Revit already holds the port.
            lastError = $"port {options.Link.Port} is busy ({e.Message}). Another Revit may have the link; set \"port\" in {ctx!.SettingsPath} to use another.";
            log.Error(lastError);
            return false;
        }
    }

    private void StopLink(bool remember)
    {
        var s = server;
        server = null;
        if (remember && ctx is not null) ctx.State[StateKeys.LinkOn] = false;
        if (s is null) return;
        // Runs on Revit's UI thread. Dispose on the thread pool, so no await inside it can need this (blocked) thread,
        // and give up after a few seconds rather than freeze Revit: the socket is already cancelled by then.
        var done = Task.Run(() => s.DisposeAsync().AsTask());
        try
        {
            if (!done.Wait(TimeSpan.FromSeconds(5))) log.Error("the link did not stop within 5 s; continuing without waiting");
        }
        catch (AggregateException e)
        {
            log.Error("stopping the link failed", e.InnerException ?? e);
        }
    }
}

/// <summary>Keys in <see cref="BrushPluginContext.State"/>. Values are BCL types only.</summary>
internal static class StateKeys
{
    public const string LinkOn = "link.on";
    public const string Ledgers = "link.ledgers";
    public const string TypeChanges = "link.typeChanges";
    public const string SessionOrigins = "link.sessionOrigins";
}

/// <summary>The settings file: the link's options plus what only the add-in reads.</summary>
internal sealed record RevitLinkOptions(LinkOptions Link, bool AutoStart = true)
{
    public RevitLinkOptions() : this(new LinkOptions()) { }

    public static RevitLinkOptions Load(string path)
    {
        var link = LinkOptions.Load(path);
        var autoStart = true;
        if (File.Exists(path) && System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(path))?["autoStart"] is { } a) autoStart = a.GetValue<bool>();
        return new RevitLinkOptions(link, autoStart);
    }
}

/// <summary>The link's log, written through the shim's log file and tagged with the plugin generation.</summary>
internal sealed class PluginLog(IBrushLog inner, int generation) : ILinkLog
{
    public void Info(string message) => inner.Info($"[#{generation}] {message}");

    public void Error(string message, Exception? e = null) => inner.Error($"[#{generation}] {message}", e);
}
