using System.Net.Sockets;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Brush.Link.Server;

namespace Brush.Revit;

/// <summary>
/// Add-in entry point. Starts the live link on Revit start-up (unless <c>autoStart</c> is false in the settings file)
/// and adds a "Brush Link" button to the Add-Ins tab that shows the link status and turns it on or off.
/// </summary>
public sealed class App : IExternalApplication
{
    public static App? Instance { get; private set; }

    public static string SettingsDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Brush");
    public static string SettingsPath => Path.Combine(SettingsDir, "revit-link.json");

    internal ILinkLog Log { get; private set; } = NullLinkLog.Instance;
    internal RevitHost? Host { get; private set; }
    internal LinkServer? Server { get; private set; }
    internal string? LastError { get; private set; }

    private RevitDispatcher? dispatcher;
    private UIControlledApplication? ui;

    public Result OnStartup(UIControlledApplication application)
    {
        Instance = this;
        ui = application;
        Log = new FileLinkLog(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Brush", "revit-link.log"));
        dispatcher = new RevitDispatcher();
        Host = new RevitHost(dispatcher, application, Log, SettingsPath);

        var panel = application.CreateRibbonPanel("Brush");
        var asm = typeof(App).Assembly.Location;
        var button = new PushButtonData("BrushLink", "Brush\nLink", asm, typeof(ToggleLinkCommand).FullName)
        {
            ToolTip = "Live link to the Brush Editor: edits sketched in the editor are applied here, and the sheet goes back as a new version.",
        };
        panel.AddItem(button);

        if (LoadOptions().AutoStart) StartLink();
        return Result.Succeeded;
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        StopLink();
        Host?.Dispose();
        dispatcher?.Dispose();
        return Result.Succeeded;
    }

    internal RevitLinkOptions LoadOptions()
    {
        try
        {
            return RevitLinkOptions.Load(SettingsPath);
        }
        catch (Exception e)
        {
            Log.Error($"bad settings file {SettingsPath}, using defaults", e);
            return new RevitLinkOptions();
        }
    }

    internal bool StartLink()
    {
        if (Server is not null) return true;
        var options = LoadOptions();
        try
        {
            var server = new LinkServer(Host!, options.Link, Log);
            server.Start();
            Server = server;
            LastError = null;
            return true;
        }
        catch (SocketException e)
        {
            // Usually a second Revit already holds the port.
            LastError = $"port {options.Link.Port} is busy ({e.Message}). Another Revit may have the link; set \"port\" in {SettingsPath} to use another.";
            Log.Error(LastError);
            return false;
        }
    }

    internal void StopLink()
    {
        var s = Server;
        Server = null;
        // DisposeAsync only cancels and waits for the accept loop; it never needs the Revit thread, so blocking is safe.
        s?.DisposeAsync().AsTask().GetAwaiter().GetResult();
    }
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

[Transaction(TransactionMode.ReadOnly)]
public sealed class ToggleLinkCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        var app = App.Instance;
        if (app is null) return Result.Failed;
        var running = app.Server is not null;
        var dlg = new TaskDialog("Brush Link")
        {
            MainInstruction = running ? "The Brush Editor link is on" : "The Brush Editor link is off",
            MainContent = running
                ? $"Editors connect to {app.Server!.Url}\nConnected editors: {app.Server.Hub.ConnectionCount}\n\nSettings: {App.SettingsPath}"
                : (app.LastError ?? "Turn it on to let the Brush Editor apply its edits to this model.") + $"\n\nSettings: {App.SettingsPath}",
            CommonButtons = TaskDialogCommonButtons.Close,
        };
        dlg.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, running ? "Turn the link off" : "Turn the link on");
        if (dlg.Show() != TaskDialogResult.CommandLink1) return Result.Succeeded;
        if (running) app.StopLink();
        else if (!app.StartLink()) TaskDialog.Show("Brush Link", app.LastError ?? "Could not start the link.");
        return Result.Succeeded;
    }
}

internal sealed class FileLinkLog : ILinkLog
{
    private readonly string path;
    private readonly object gate = new();

    public FileLinkLog(string path)
    {
        this.path = path;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    }

    public void Info(string message) => Write("info", message);

    public void Error(string message, Exception? e = null) => Write("error", e is null ? message : $"{message}: {e}");

    private void Write(string level, string message)
    {
        try
        {
            lock (gate) File.AppendAllText(path, $"{DateTime.Now:O} {level} {message}{Environment.NewLine}");
        }
        catch (IOException)
        {
        }
    }
}
