using System.Collections.Concurrent;
using Autodesk.Revit.UI;

namespace Brush.Revit.Plugins;

/// <summary>
/// What the hot-reloadable part of the add-in (Brush.Revit.Link.dll) implements. The shim (this assembly) is the only
/// thing Revit loads directly; it finds the one public non-abstract <see cref="IBrushPlugin"/> in the plugin assembly,
/// creates it with a parameterless constructor, and swaps it for a fresh one whenever the plugin's DLL is rebuilt.
///
/// Rules for the plugin, so the old copy can be unloaded:
/// - Undo in <see cref="IDisposable.Dispose"/> everything <see cref="Start"/> did: unsubscribe Revit events, stop
///   servers and timers, release sockets.
/// - Keep anything that must survive a reload in <see cref="BrushPluginContext.State"/>, and only as BCL types
///   (string, List, Dictionary, ...): a type from the plugin assembly would pin the old copy and would not be the
///   "same" type for the new one anyway.
/// - Never create an <see cref="ExternalEvent"/> or a ribbon item: those stay in the shim for the whole Revit session.
/// </summary>
public interface IBrushPlugin : IDisposable
{
    /// <summary>Called on Revit's API thread, right after the plugin is created.</summary>
    void Start(BrushPluginContext context);

    /// <summary>The ribbon button was pressed. Called on Revit's API thread.</summary>
    void OnRibbonButton(UIApplication app);
}

/// <summary>Everything the shim hands to the plugin. Lives as long as Revit does, except the per-load fields.</summary>
public sealed class BrushPluginContext
{
    internal BrushPluginContext(UIControlledApplication ui, RevitDispatcher dispatcher, IBrushLog log, string settingsPath,
        ConcurrentDictionary<string, object> state, int generation, Action requestReload, string loadedFrom)
    {
        Ui = ui;
        Dispatcher = dispatcher;
        Log = log;
        SettingsPath = settingsPath;
        State = state;
        Generation = generation;
        RequestReload = requestReload;
        LoadedFrom = loadedFrom;
    }

    public UIControlledApplication Ui { get; }

    /// <summary>Runs work on Revit's API thread. Owned by the shim (an ExternalEvent cannot be unloaded).</summary>
    public RevitDispatcher Dispatcher { get; }

    public IBrushLog Log { get; }

    public string SettingsPath { get; }

    /// <summary>Survives hot reloads. BCL types only (see <see cref="IBrushPlugin"/>).</summary>
    public ConcurrentDictionary<string, object> State { get; }

    /// <summary>1 for the copy loaded at Revit start-up, +1 for every reload.</summary>
    public int Generation { get; }

    /// <summary>Ask the shim to load the plugin again from disk (queued; returns at once).</summary>
    public Action RequestReload { get; }

    /// <summary>The folder the plugin DLL was loaded from.</summary>
    public string LoadedFrom { get; }
}

public interface IBrushLog
{
    void Info(string message);
    void Error(string message, Exception? e = null);
}
