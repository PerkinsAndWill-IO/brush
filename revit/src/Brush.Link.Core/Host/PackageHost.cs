using Brush.Link.Geometry;
using Brush.Link.Model;
using Brush.Link.Planning;

namespace Brush.Link.Host;

/// <summary>
/// A stand-in for Revit over an editor <c>.drawing</c> package held in memory. Commands become manifest elements
/// directly in sheet points, so the editor sees its edits come back without a model. The PDF never changes
/// (nothing renders it again), only the manifest does.
///
/// It runs the same <see cref="CommandPlanner"/> as Revit against one plan viewport that covers the whole sheet,
/// so a command Revit would reject is rejected here too.
/// </summary>
public sealed class PackageHost : ILinkHost
{
    private readonly object gate = new();
    private readonly string? project;
    private readonly TypePalette? palette;
    private readonly string? pdfName;
    private readonly byte[]? pdf;
    private readonly List<MutableSheet> sheets;
    private readonly CommandLedger ledger = new();
    private long nextId = 900_000;

    public PackageHost(DrawingManifest manifest, string? pdfName, byte[]? pdf, string title = "package")
    {
        project = manifest.Project;
        palette = manifest.Palette;
        this.pdfName = pdfName;
        this.pdf = pdf;
        Title = title;
        sheets = manifest.Sheets.Select(s => new MutableSheet(s)).ToList();
    }

    public static PackageHost FromFile(string path)
    {
        var (m, name, bytes) = DrawingPackage.Parse(File.ReadAllBytes(path));
        return new PackageHost(m, name, bytes, System.IO.Path.GetFileName(path));
    }

    public string Name => "DevHost";

    public string Title { get; }

    /// <summary>Answer for origins not in the allow list. The dev host has no UI to ask, so the default is no.</summary>
    public Func<string, bool> ApproveOrigin { get; set; } = _ => false;

    public event Action<IReadOnlyCollection<string>?>? ModelChanged;

    private sealed class MutableSheet(ManifestSheet s)
    {
        public ManifestSheet Sheet { get; } = s;
        public List<ManifestElement> Elements { get; } = s.Elements.ToList();

        public ManifestSheet Snapshot() => Sheet with { Elements = Elements.ToList() };
    }

    private MutableSheet Find(string sheetId) =>
        sheets.FirstOrDefault(s => s.Sheet.Id == sheetId) ?? throw new KeyNotFoundException($"no sheet '{sheetId}'");

    public Task<DocumentInfo> GetDocumentAsync(CancellationToken ct)
    {
        lock (gate) return Task.FromResult(new DocumentInfo(Title, null, project, sheets.Select(s => new SheetSummary(s.Sheet.Id, s.Sheet.Number, s.Sheet.Name)).ToList()));
    }

    public Task<SheetExport> ExportSheetAsync(string sheetId, CancellationToken ct)
    {
        lock (gate) return Task.FromResult(new SheetExport(Find(sheetId).Snapshot(), palette, project, pdfName, pdf));
    }

    /// <summary>Synthetic geometry: the whole page is one plan viewport at the sheet's scale, model origin at the page's bottom-left.</summary>
    public static SheetGeometry GeometryOf(ManifestSheet s)
    {
        var frame = new SheetFrame(new SheetBox(0, 0, s.SizePt.W / SheetFrame.PointsPerFoot, s.SizePt.H / SheetFrame.PointsPerFoot));
        var k = s.Scale ?? 100;
        var vp = new ViewportInfo
        {
            ViewId = $"{s.Id}-plan", ViewName = s.Name, Box = frame.Page, IsPlan = true, Scale = k,
            SheetToModel = new Transform3(new(0, 0, 0), new(k, 0, 0), new(0, k, 0), new(0, 0, 1)),
        };
        return new SheetGeometry(frame, [vp]);
    }

    public Task<IReadOnlyList<CommandResult>> ApplyAsync(string sheetId, IReadOnlyList<Command> commands, CancellationToken ct)
    {
        lock (gate)
        {
            var sheet = Find(sheetId);
            var geometry = GeometryOf(sheet.Sheet);
            var results = new List<CommandResult>();
            foreach (var c in commands)
            {
                if (c.SheetId != sheetId)
                {
                    results.Add(CommandResult.Failed(c.Id, $"command is for sheet '{c.SheetId}', batch is for '{sheetId}'"));
                    continue;
                }
                if (ledger.Knows(c.Id))
                {
                    results.Add(CommandResult.Skipped(c.Id, "already applied"));
                    continue;
                }
                var op = CommandPlanner.Plan(c, geometry, ledger.Knows);
                results.Add(op switch
                {
                    RejectedOp r => CommandResult.Failed(c.Id, r.Reason),
                    DeleteOp d => Delete(sheet, d),
                    _ => Add(sheet, c),
                });
            }
            return Task.FromResult<IReadOnlyList<CommandResult>>(results);
        }
    }

    private CommandResult Add(MutableSheet sheet, Command c)
    {
        var id = (nextId++).ToString(System.Globalization.CultureInfo.InvariantCulture);
        ManifestElement? e = c switch
        {
            CreateWall w => new ManifestElement { Id = id, Category = "Walls", TypeName = w.WallType, Footprint = w.Path.Points.ToList(), Closed = w.Path.Closed ? true : null },
            PlaceDoor d => new ManifestElement { Id = id, Category = "Doors", TypeName = d.FamilyType, Footprint = DoorSegment(d), Props = d.HostWallRef is null ? null : new Dictionary<string, string> { ["hostWall"] = d.HostWallRef } },
            PlaceInstance p => new ManifestElement { Id = id, Category = "Furniture", TypeName = p.Family, Footprint = Corners(p) },
            _ => null,
        };
        if (e is null) return CommandResult.Skipped(c.Id, $"unsupported op '{c.Op}'");
        sheet.Elements.Add(e);
        ledger.Record(c.Id, [id]);
        return CommandResult.Applied(c.Id, [id]);
    }

    private CommandResult Delete(MutableSheet sheet, DeleteOp d)
    {
        var ids = d.HostIds.Concat(d.CommandIds.SelectMany(ledger.ElementsOf)).ToHashSet(StringComparer.Ordinal);
        var removed = sheet.Elements.Where(e => ids.Contains(e.Id)).Select(e => e.Id).ToList();
        sheet.Elements.RemoveAll(e => ids.Contains(e.Id));
        if (removed.Count == 0) return CommandResult.Skipped(d.CommandId, "targets are already gone");
        ledger.Record(d.CommandId, []);
        var notes = d.Unresolved.Count > 0 ? new[] { $"ignored targets that name no element: {string.Join(", ", d.Unresolved)}" } : null;
        return CommandResult.Applied(d.CommandId, removed, notes);
    }

    public Task<IReadOnlyList<CommandResult>> RevertAsync(IReadOnlyList<string> commandIds, CancellationToken ct)
    {
        lock (gate)
        {
            var results = new List<CommandResult>();
            foreach (var id in commandIds)
            {
                if (!ledger.Knows(id))
                {
                    results.Add(CommandResult.Skipped(id, "not a command of this link"));
                    continue;
                }
                var els = ledger.ElementsOf(id).ToHashSet(StringComparer.Ordinal);
                foreach (var s in sheets) s.Elements.RemoveAll(e => els.Contains(e.Id));
                ledger.Forget(id);
                results.Add(els.Count == 0 ? CommandResult.Skipped(id, "a delete cannot be reverted by the dev host") : CommandResult.Applied(id, els.ToList()));
            }
            return Task.FromResult<IReadOnlyList<CommandResult>>(results);
        }
    }

    /// <summary>The sheet last shown with <see cref="ShowSheetAsync"/> (the DevHost has no views; tests read this).</summary>
    public string? ShownSheet { get; private set; }

    public Task ShowSheetAsync(string sheetId, CancellationToken ct)
    {
        lock (gate) ShownSheet = Find(sheetId).Sheet.Id;
        return Task.CompletedTask;
    }

    public Task<bool> ApproveOriginAsync(string origin, CancellationToken ct) => Task.FromResult(ApproveOrigin(origin));

    /// <summary>Simulate someone editing the model in the host: change a sheet outside the link.</summary>
    public void ExternalEdit(string sheetId, Action<List<ManifestElement>> edit)
    {
        lock (gate) edit(Find(sheetId).Elements);
        ModelChanged?.Invoke([sheetId]);
    }

    private static List<SheetPoint> DoorSegment(PlaceDoor d)
    {
        var h = d.WidthPt / 2;
        var (c, s) = (Math.Cos(d.AngleRad), Math.Sin(d.AngleRad));
        return [new(d.At.X - c * h, d.At.Y - s * h), new(d.At.X + c * h, d.At.Y + s * h)];
    }

    private static List<SheetPoint> Corners(PlaceInstance p)
    {
        var (c, s) = (Math.Cos(p.AngleRad), Math.Sin(p.AngleRad));
        var (hw, hh) = (p.Bbox.W / 2, p.Bbox.H / 2);
        return new[] { (-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh) }
            .Select(v => new SheetPoint(p.At.X + v.Item1 * c - v.Item2 * s, p.At.Y + v.Item1 * s + v.Item2 * c)).ToList();
    }
}
