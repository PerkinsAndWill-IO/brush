using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Autodesk.Revit.UI;

namespace Brush.Revit.Plugins;

/// <summary>
/// Loads Brush.Revit.Link.dll into a collectible <see cref="HotLoadContext"/> and, when hot reload is on, watches its
/// folder: after a rebuild, the running copy is stopped, the new one is started, and the old context is unloaded.
/// No Revit restart.
///
/// If the new copy fails to load or to start, the previous one is started again, so a bad build never leaves you
/// without a link. All swaps run on Revit's API thread through the <see cref="RevitDispatcher"/>.
/// </summary>
internal sealed class PluginLoader : IDisposable
{
    public const string PluginAssembly = "Brush.Revit.Link";

    private readonly UIControlledApplication ui;
    private readonly RevitDispatcher dispatcher;
    private readonly IBrushLog log;
    private readonly string settingsPath;
    private readonly ConcurrentDictionary<string, object> state = new(StringComparer.Ordinal);
    private readonly object timerGate = new();
    private FileSystemWatcher? watcher;
    private Timer? debounce;
    private Slot? current;
    private int generation;
    private bool disposed;

    public PluginLoader(UIControlledApplication ui, RevitDispatcher dispatcher, IBrushLog log, string settingsPath)
    {
        this.ui = ui;
        this.dispatcher = dispatcher;
        this.log = log;
        this.settingsPath = settingsPath;
        (HotReload, Folder) = ReadSettings(settingsPath, log);
    }

    /// <summary>Where the plugin DLLs are loaded from (and watched, with hot reload on).</summary>
    public string Folder { get; }

    public bool HotReload { get; }

    public string? LastError { get; private set; }

    public DateTime? LoadedAt { get; private set; }

    public int Generation => current?.Generation ?? 0;

    /// <summary>Set by the app so the loader can show the loaded version in the button's tooltip.</summary>
    public PushButton? Button { get; set; }

    /// <summary>First load. Call from OnStartup (an API context).</summary>
    public void Start()
    {
        ReloadNow(manual: false);
        if (!HotReload) return;
        try
        {
            watcher = new FileSystemWatcher(Folder, "*.dll") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size };
            watcher.Changed += (_, _) => ScheduleReload();
            watcher.Created += (_, _) => ScheduleReload();
            watcher.Renamed += (_, _) => ScheduleReload();
            watcher.EnableRaisingEvents = true;
            log.Info($"hot reload on: watching {Folder}");
        }
        catch (Exception e)
        {
            log.Error($"hot reload: could not watch {Folder}", e);
        }
    }

    /// <summary>Queue a reload on the API thread. Any thread. Several calls within the debounce window make one.</summary>
    public void ScheduleReload()
    {
        lock (timerGate)
        {
            if (disposed) return;
            // A build writes several files in a burst; wait until it has been quiet for a moment.
            debounce ??= new Timer(_ => QueueReload(manual: false));
            debounce.Change(TimeSpan.FromMilliseconds(800), Timeout.InfiniteTimeSpan);
        }
    }

    public void RequestReload() => QueueReload(manual: true);

    private void QueueReload(bool manual)
    {
        if (disposed) return;
        dispatcher.InvokeAsync(_ =>
        {
            ReloadNow(manual);
            return true;
        }).ContinueWith(t => log.Error("hot reload: could not run on the Revit thread", t.Exception), TaskContinuationOptions.OnlyOnFaulted);
    }

    /// <summary>Load the plugin from disk and swap it in. API thread only.</summary>
    public void ReloadNow(bool manual)
    {
        if (disposed) return;
        string hash;
        try
        {
            hash = FolderHash();
        }
        catch (Exception e)
        {
            Fail($"could not read the plugin from {Folder}", e, showDialog: current is not null);
            return;
        }
        // Builds often rewrite identical files (deterministic output); only a real change is worth a swap.
        if (!manual && current is not null && current.Hash == hash) return;

        var next = generation + 1;
        Slot fresh;
        try
        {
            fresh = Slot.Load(Folder, next, hash);
        }
        catch (Exception e)
        {
            Fail(current is null ? "the plugin did not load" : "the new build did not load; the previous one keeps running", e, showDialog: current is not null);
            return;
        }

        var old = current;
        current = null;
        if (old is not null) SafeDispose(old.Plugin, $"stopping plugin #{old.Generation}");

        try
        {
            fresh.Plugin.Start(ContextFor(next));
            generation = next;
            current = fresh;
            LastError = null;
            LoadedAt = DateTime.Now;
            log.Info(old is null ? $"plugin #{next} started from {Folder}" : $"hot reload: plugin #{next} replaced #{old.Generation}");
            if (old is not null) UnloadInBackground(old.Context, old.Generation, log);
        }
        catch (Exception e)
        {
            SafeDispose(fresh.Plugin, $"stopping plugin #{next} after its failed start");
            fresh.Context.Unload();
            generation = next; // keep numbers unique even for a failed copy
            if (old is null)
            {
                Fail("the plugin did not start", e, showDialog: false);
            }
            else
            {
                Fail($"the new build threw on start; going back to plugin #{old.Generation}", e, showDialog: true);
                Restart(old);
            }
        }
        UpdateButton();
    }

    /// <summary>Start a fresh instance from an already-loaded copy (the last good one).</summary>
    private void Restart(Slot old)
    {
        try
        {
            var again = old.WithNewInstance();
            again.Plugin.Start(ContextFor(old.Generation));
            current = again;
            log.Info($"plugin #{old.Generation} is running again");
        }
        catch (Exception e)
        {
            Fail($"plugin #{old.Generation} did not restart either; the link is off until the next good build", e, showDialog: false);
            old.Context.Unload();
        }
    }

    public void OnRibbonButton(UIApplication app)
    {
        if (current is { } c)
        {
            try
            {
                c.Plugin.OnRibbonButton(app);
            }
            catch (Exception e)
            {
                log.Error("plugin button handler threw", e);
                TaskDialog.Show("Brush Link", $"The plugin threw an error:\n\n{e.Message}\n\nDetails in the log.");
            }
            return;
        }
        var dlg = new TaskDialog("Brush Link")
        {
            MainInstruction = "The Brush plugin is not loaded",
            MainContent = $"{LastError ?? "No error recorded."}\n\nPlugin folder: {Folder}\nLog: {App.LogPath}",
            CommonButtons = TaskDialogCommonButtons.Close,
        };
        dlg.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, "Try loading it again");
        if (dlg.Show() == TaskDialogResult.CommandLink1) ReloadNow(manual: true);
    }

    private BrushPluginContext ContextFor(int gen) =>
        new(ui, dispatcher, log, settingsPath, state, gen, RequestReload, Folder);

    private void Fail(string what, Exception e, bool showDialog)
    {
        var inner = e is System.Reflection.TargetInvocationException { InnerException: { } ie } ? ie : e;
        LastError = $"{what}: {inner.GetType().Name}: {inner.Message}";
        log.Error($"hot reload: {what}", inner);
        if (showDialog)
        {
            try
            {
                TaskDialog.Show("Brush hot reload", $"{what}.\n\n{inner.GetType().Name}: {inner.Message}\n\nLog: {App.LogPath}");
            }
            catch (Exception)
            {
                // No dialog outside an API context; the log has it.
            }
        }
    }

    private void SafeDispose(IBrushPlugin plugin, string what)
    {
        try
        {
            plugin.Dispose();
        }
        catch (Exception e)
        {
            log.Error($"hot reload: {what} threw (ignored)", e);
        }
    }

    private void UpdateButton()
    {
        if (Button is null) return;
        try
        {
            var status = current is not null
                ? $"Plugin #{current.Generation} loaded {LoadedAt:HH:mm:ss}{(HotReload ? " (hot reload on)" : "")}."
                : $"Plugin not loaded: {LastError}";
            Button.ToolTip = $"Live link to the Brush Editor: edits sketched in the editor are applied here, and the sheet goes back as a new version.\n\n{status}";
        }
        catch (Exception)
        {
            // Cosmetic only.
        }
    }

    private string FolderHash()
    {
        using var sha = SHA256.Create();
        foreach (var f in Directory.GetFiles(Folder, "*.dll").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
        {
            if (Path.GetFileNameWithoutExtension(f).Equals(typeof(App).Assembly.GetName().Name, StringComparison.OrdinalIgnoreCase)) continue;
            var bytes = HotLoadContext.ReadShared(f);
            sha.TransformBlock(bytes, 0, bytes.Length, null, 0);
        }
        sha.TransformFinalBlock([], 0, 0);
        return Convert.ToHexString(sha.Hash!);
    }

    /// <summary>Unload an old copy and report, a bit later, whether it really left memory.</summary>
    private static void UnloadInBackground(HotLoadContext context, int gen, IBrushLog log)
    {
        var weak = new WeakReference(context);
        context.Unload();
        _ = Task.Run(async () =>
        {
            for (var i = 0; i < 10 && weak.IsAlive; i++)
            {
                await Task.Delay(500);
                GC.Collect();
                GC.WaitForPendingFinalizers();
            }
            log.Info(weak.IsAlive
                ? $"hot reload: plugin #{gen} is still in memory (something still references it: an event handler, timer or thread it did not stop). Harmless, it just stays until Revit closes."
                : $"hot reload: plugin #{gen} unloaded");
        });
    }

    private static (bool hotReload, string folder) ReadSettings(string settingsPath, IBrushLog log)
    {
#if DEBUG
        var hotReload = true;
#else
        var hotReload = false;
#endif
        var folder = Path.GetDirectoryName(typeof(App).Assembly.Location)!;
        try
        {
            if (File.Exists(settingsPath) && JsonNode.Parse(File.ReadAllText(settingsPath)) is JsonObject o)
            {
                if (o["hotReload"] is { } h) hotReload = h.GetValue<bool>();
                if (o["pluginDir"]?.GetValue<string>() is { Length: > 0 } d) folder = Environment.ExpandEnvironmentVariables(d);
            }
        }
        catch (Exception e)
        {
            log.Error($"bad settings file {settingsPath}; hot reload uses defaults", e);
        }
        if (Environment.GetEnvironmentVariable("BRUSH_HOT_RELOAD") is { Length: > 0 } env) hotReload = env is "1" or "true" or "on";
        return (hotReload, folder);
    }

    public void Dispose()
    {
        lock (timerGate)
        {
            disposed = true;
            debounce?.Dispose();
        }
        watcher?.Dispose();
        if (current is not null) SafeDispose(current.Plugin, "shutting down");
        current = null;
    }

    private sealed record Slot(HotLoadContext Context, Type PluginType, IBrushPlugin Plugin, int Generation, string Hash)
    {
        public static Slot Load(string folder, int gen, string hash)
        {
            var context = new HotLoadContext(folder, gen);
            try
            {
                var asm = context.LoadPlugin(PluginAssembly);
                var types = asm.GetTypes().Where(t => t is { IsPublic: true, IsAbstract: false } && typeof(IBrushPlugin).IsAssignableFrom(t)).ToList();
                if (types.Count != 1)
                    throw new InvalidOperationException($"{PluginAssembly}.dll must have exactly one public IBrushPlugin, found {types.Count}");
                return new Slot(context, types[0], (IBrushPlugin)Activator.CreateInstance(types[0])!, gen, hash);
            }
            catch
            {
                context.Unload();
                throw;
            }
        }

        public Slot WithNewInstance() => this with { Plugin = (IBrushPlugin)Activator.CreateInstance(PluginType)! };
    }
}
