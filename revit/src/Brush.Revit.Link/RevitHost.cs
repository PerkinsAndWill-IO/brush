using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using System.Collections.Concurrent;
using Brush.Link.Host;
using Brush.Link.Model;
using Brush.Link.Server;

namespace Brush.Revit;

/// <summary>
/// <see cref="ILinkHost"/> for Revit. The link works on the active document. Every call runs on Revit's API thread
/// through the <see cref="RevitDispatcher"/>.
/// </summary>
internal sealed class RevitHost : ILinkHost, IDisposable
{
    private readonly RevitDispatcher dispatcher;
    private readonly UIControlledApplication ui;
    private readonly ILinkLog log;
    private readonly string settingsPath;
    // Per document: which elements each command created, keyed by the document's path or title. The backing
    // dictionaries live in the shim's reload-proof state (BCL types only), so an editor can still revert commands
    // that an earlier copy of the plugin applied.
    private readonly Dictionary<string, Dictionary<string, List<string>>> ledgers;
    // Per document, likewise: the types each set_type command replaced, so revert can put them back.
    private readonly Dictionary<string, Dictionary<string, List<string>>> typeChanges;
    // Origins the user allowed "this time": also kept across reloads so a rebuild does not ask again.
    private readonly HashSet<string> sessionOrigins;
    private bool applying;

    public RevitHost(RevitDispatcher dispatcher, UIControlledApplication ui, ILinkLog log, string settingsPath, ConcurrentDictionary<string, object> state)
    {
        this.dispatcher = dispatcher;
        this.ui = ui;
        this.log = log;
        this.settingsPath = settingsPath;
        ledgers = (Dictionary<string, Dictionary<string, List<string>>>)state.GetOrAdd(StateKeys.Ledgers, _ => new Dictionary<string, Dictionary<string, List<string>>>(StringComparer.OrdinalIgnoreCase));
        typeChanges = (Dictionary<string, Dictionary<string, List<string>>>)state.GetOrAdd(StateKeys.TypeChanges, _ => new Dictionary<string, Dictionary<string, List<string>>>(StringComparer.OrdinalIgnoreCase));
        sessionOrigins = (HashSet<string>)state.GetOrAdd(StateKeys.SessionOrigins, _ => new HashSet<string>(StringComparer.Ordinal));
        ui.ControlledApplication.DocumentChanged += OnDocumentChanged;
        ui.ViewActivated += OnViewActivated;
    }

    public string Name => $"Revit {ui.ControlledApplication.VersionNumber}";

    public event Action<IReadOnlyCollection<string>?>? ModelChanged;

    private static Document ActiveDocument(UIApplication app) =>
        app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("no model is open in Revit");

    private CommandLedger LedgerOf(Document doc)
    {
        var key = string.IsNullOrEmpty(doc.PathName) ? doc.Title : doc.PathName;
        lock (ledgers)
        {
            if (!ledgers.TryGetValue(key, out var l)) ledgers[key] = l = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            if (!typeChanges.TryGetValue(key, out var t)) typeChanges[key] = t = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            return new CommandLedger(l, t);
        }
    }

    public Task<DocumentInfo> GetDocumentAsync(CancellationToken ct) => dispatcher.InvokeAsync(app =>
    {
        var doc = ActiveDocument(app);
        var sheets = SheetReader.Sheets(doc).Select(s => new SheetSummary(SheetReader.IdOf(s), s.SheetNumber, s.Name)).ToList();
        return new DocumentInfo(doc.Title, string.IsNullOrEmpty(doc.PathName) ? null : doc.PathName, ProjectName(doc), sheets);
    }, ct);

    public Task<SheetExport> ExportSheetAsync(string sheetId, CancellationToken ct) => dispatcher.InvokeAsync(app =>
    {
        var doc = ActiveDocument(app);
        var sheet = SheetReader.FindSheet(doc, sheetId);
        var started = DateTime.UtcNow;
        var manifest = SheetReader.ManifestOf(sheet);
        var pdf = SheetReader.PdfOf(sheet);
        log.Info($"exported {sheet.SheetNumber} ({manifest.Elements.Count} elements, {pdf.Length / 1024} KB PDF) in {(DateTime.UtcNow - started).TotalMilliseconds:F0} ms");
        return new SheetExport(manifest, SheetReader.PaletteOf(doc), ProjectName(doc), $"{sheet.SheetNumber}.pdf", pdf);
    }, ct);

    public Task<IReadOnlyList<CommandResult>> ApplyAsync(string sheetId, IReadOnlyList<Command> commands, CancellationToken ct) => dispatcher.InvokeAsync(app =>
    {
        var doc = ActiveDocument(app);
        var sheet = SheetReader.FindSheet(doc, sheetId);
        applying = true;
        try
        {
            var results = new CommandApplier(doc, LedgerOf(doc)).Apply(sheet, sheetId, commands);
            log.Info($"applied {results.Count(r => r.Status == CommandStatus.Applied)}/{results.Count} commands to {sheet.SheetNumber}");
            return results;
        }
        finally
        {
            applying = false;
        }
    }, ct);

    public Task<IReadOnlyList<CommandResult>> RevertAsync(IReadOnlyList<string> commandIds, CancellationToken ct) => dispatcher.InvokeAsync(app =>
    {
        var doc = ActiveDocument(app);
        applying = true;
        try
        {
            return new CommandApplier(doc, LedgerOf(doc)).Revert(commandIds);
        }
        finally
        {
            applying = false;
        }
    }, ct);

    /// <summary>S1-07: the element's valid types (<c>Element.GetValidTypes()</c>) and its current type.</summary>
    public Task<TypeList> ListTypesAsync(string elementId, CancellationToken ct) => dispatcher.InvokeAsync(app =>
    {
        var doc = ActiveDocument(app);
        var element = (SheetReader.ParseId(elementId) is { } id ? doc.GetElement(id) : null)
            ?? throw new KeyNotFoundException($"no element '{elementId}' in {doc.Title}");
        static TypeInfo Info(ElementType t) => new(string.IsNullOrEmpty(t.FamilyName) ? null : t.FamilyName, t.Name, SheetReader.IdOf(t));
        var current = doc.GetElement(element.GetTypeId()) as ElementType;
        var types = element.GetValidTypes().Select(doc.GetElement).OfType<ElementType>()
            .OrderBy(t => t.FamilyName, StringComparer.OrdinalIgnoreCase).ThenBy(t => t.Name, StringComparer.OrdinalIgnoreCase)
            .Select(Info).ToList();
        if (current is not null && !types.Exists(t => t.TypeId == SheetReader.IdOf(current))) types.Insert(0, Info(current));
        return new TypeList(elementId, current is null ? null : Info(current), types);
    }, ct);

    public Task ShowSheetAsync(string sheetId, CancellationToken ct) => dispatcher.InvokeAsync(app =>
    {
        var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("no model is open in Revit");
        var sheet = SheetReader.FindSheet(uidoc.Document, sheetId);
        if (uidoc.ActiveView?.Id != sheet.Id) uidoc.ActiveView = sheet;
        log.Info($"showing {sheet.SheetNumber} in Revit");
        return true;
    }, ct);

    public Task<bool> ApproveOriginAsync(string origin, CancellationToken ct) => dispatcher.InvokeAsync(_ =>
    {
        lock (sessionOrigins)
            if (sessionOrigins.Contains(origin)) return true;
        var dlg = new TaskDialog("Brush Link")
        {
            MainInstruction = "Let a web page edit this model?",
            MainContent = $"{origin}\nwants to connect to the Brush Link. If you allow it, that page can add and delete walls, doors and furniture in the open model.\n\nOnly allow pages you trust, such as the Brush Editor.",
            MainIcon = TaskDialogIcon.TaskDialogIconWarning,
            CommonButtons = TaskDialogCommonButtons.Cancel,
            DefaultButton = TaskDialogResult.Cancel,
        };
        dlg.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, "Allow this time");
        dlg.AddCommandLink(TaskDialogCommandLinkId.CommandLink2, "Always allow this page", $"Saved in {settingsPath}");
        var answer = dlg.Show();
        if (answer == TaskDialogResult.CommandLink2)
        {
            LinkOptions.AddAllowedOrigin(settingsPath, origin);
            return true;
        }
        if (answer != TaskDialogResult.CommandLink1) return false;
        lock (sessionOrigins) sessionOrigins.Add(origin);
        return true;
    }, ct);

    private static string? ProjectName(Document doc)
    {
        var name = doc.ProjectInformation?.Name;
        return string.IsNullOrWhiteSpace(name) || name == "Project Name" ? null : name;
    }

    private void OnDocumentChanged(object? sender, DocumentChangedEventArgs e)
    {
        // Our own transactions are followed by an explicit refresh; only edits made in Revit count here.
        if (applying) return;
        // Which sheets an edit shows on is not cheap to know (an element is seen in every view of its level), so
        // every open sheet is re-exported; the hub only pushes the ones whose export actually changed.
        ModelChanged?.Invoke(null);
    }

    private void OnViewActivated(object? sender, ViewActivatedEventArgs e)
    {
        // Switching to another model changes the sheet list.
        if (e.PreviousActiveView is null || !e.PreviousActiveView.Document.Equals(e.Document)) ModelChanged?.Invoke(null);
    }

    public void Dispose()
    {
        ui.ControlledApplication.DocumentChanged -= OnDocumentChanged;
        ui.ViewActivated -= OnViewActivated;
    }
}
