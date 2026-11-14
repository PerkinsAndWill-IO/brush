using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
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
    // Per document: which elements each command created. Keyed by the document's path or title.
    private readonly Dictionary<string, CommandLedger> ledgers = new(StringComparer.OrdinalIgnoreCase);
    private bool applying;

    public RevitHost(RevitDispatcher dispatcher, UIControlledApplication ui, ILinkLog log, string settingsPath)
    {
        this.dispatcher = dispatcher;
        this.ui = ui;
        this.log = log;
        this.settingsPath = settingsPath;
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
        if (!ledgers.TryGetValue(key, out var l)) ledgers[key] = l = new CommandLedger();
        return l;
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

    public Task<bool> ApproveOriginAsync(string origin, CancellationToken ct) => dispatcher.InvokeAsync(_ =>
    {
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
        return answer == TaskDialogResult.CommandLink1;
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
