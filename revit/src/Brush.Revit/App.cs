using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Brush.Revit.Plugins;

namespace Brush.Revit;

/// <summary>
/// Add-in entry point: the shim. It is the only assembly Revit loads directly, and it stays small on purpose so it
/// rarely needs a Revit restart. It owns what must live for the whole session (the ribbon buttons and the
/// <see cref="RevitDispatcher"/>'s ExternalEvent) and loads everything else (the link, reading sheets, applying
/// commands) from Brush.Revit.Link.dll through the <see cref="PluginLoader"/>, which swaps it after every rebuild
/// when hot reload is on.
/// </summary>
public sealed class App : IExternalApplication
{
    public static App? Instance { get; private set; }

    public static string SettingsDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Brush");
    public static string SettingsPath => Path.Combine(SettingsDir, "revit-link.json");
    public static string LogPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Brush", "revit-link.log");

    internal PluginLoader? Loader { get; private set; }

    private RevitDispatcher? dispatcher;

    public Result OnStartup(UIControlledApplication application)
    {
        Instance = this;
        var log = new FileBrushLog(LogPath);
        try
        {
            dispatcher = new RevitDispatcher(log);
            Loader = new PluginLoader(application, dispatcher, log, SettingsPath);

            var panel = application.CreateRibbonPanel("Brush");
            var asm = typeof(App).Assembly.Location;
            Loader.Button = panel.AddItem(new PushButtonData("BrushLink", "Brush\nLink", asm, typeof(ToggleLinkCommand).FullName)
            {
                ToolTip = "Live link to the Brush Editor: edits sketched in the editor are applied here, and the sheet goes back as a new version.",
            }) as PushButton;
            if (Loader.HotReload)
            {
                panel.AddItem(new PushButtonData("BrushReload", "Reload\nBrush", asm, typeof(ReloadPluginCommand).FullName)
                {
                    ToolTip = $"Load Brush.Revit.Link.dll again from {Loader.Folder}. Happens by itself after a build; this is for when it did not.",
                });
            }

            Loader.Start();
        }
        catch (Exception e)
        {
            // Never take Revit's start-up down with us.
            log.Error("Brush add-in failed to start", e);
        }
        return Result.Succeeded;
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        Loader?.Dispose();
        dispatcher?.Dispose();
        return Result.Succeeded;
    }
}

[Transaction(TransactionMode.ReadOnly)]
public sealed class ToggleLinkCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        var loader = App.Instance?.Loader;
        if (loader is null) return Result.Failed;
        loader.OnRibbonButton(commandData.Application);
        return Result.Succeeded;
    }
}

[Transaction(TransactionMode.ReadOnly)]
public sealed class ReloadPluginCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        var loader = App.Instance?.Loader;
        if (loader is null) return Result.Failed;
        loader.ReloadNow(manual: true);
        return Result.Succeeded;
    }
}

internal sealed class FileBrushLog : IBrushLog
{
    private readonly string path;
    private readonly object gate = new();

    public FileBrushLog(string path)
    {
        this.path = path;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        }
        catch (IOException)
        {
        }
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
