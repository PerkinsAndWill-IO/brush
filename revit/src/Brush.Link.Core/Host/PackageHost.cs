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
                    SetTypeOp t => SetTypes(sheet, t),
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

    /// <summary>
    /// The DevHost's model has no type table: an element can take any type its category uses on any sheet, or that the
    /// palette lists for it. Matched like Revit (<see cref="TypeMatch"/>).
    /// </summary>
    private CommandResult SetTypes(MutableSheet sheet, SetTypeOp op)
    {
        var notes = new List<string>();
        var errors = new List<string>();
        var changes = new List<TypeChange>();
        var touched = new List<string>();
        if (op.Unresolved.Count > 0) notes.Add($"ignored targets that name no element: {string.Join(", ", op.Unresolved)}");
        foreach (var id in op.HostIds)
        {
            var i = sheet.Elements.FindIndex(e => e.Id == id);
            if (i < 0)
            {
                errors.Add($"no element {id} on this sheet");
                continue;
            }
            var e = sheet.Elements[i];
            var m = TypeMatch.Find(TypesFor(e.Category), op.TypeName, op.Family, e.Category);
            if (m.Hit is null)
            {
                errors.Add($"{id}: {m.Error}");
                continue;
            }
            if (m.Note is not null && !notes.Contains(m.Note)) notes.Add(m.Note);
            touched.Add(id);
            var to = m.Hit.Key;
            if (e.TypeName == to)
            {
                notes.Add($"{id} is already '{to}'");
                continue;
            }
            changes.Add(new TypeChange(id, e.TypeName ?? "", to));
            sheet.Elements[i] = e with { TypeName = to };
        }
        if (touched.Count == 0) return CommandResult.Failed(op.CommandId, string.Join("; ", errors));
        notes.AddRange(errors);
        ledger.RecordTypeChanges(op.CommandId, changes);
        return CommandResult.Applied(op.CommandId, touched, notes);
    }

    private List<TypeCandidate<string>> TypesFor(string category)
    {
        var names = sheets.SelectMany(s => s.Elements).Where(e => e.Category == category && e.TypeName is { Length: > 0 }).Select(e => e.TypeName!);
        var palette = category switch
        {
            "Walls" => this.palette?.Walls?.Select(w => w.Name),
            "Doors" => this.palette?.Doors?.Select(d => d.Name),
            "Furniture" => this.palette?.Furniture?.Select(f => f.Name),
            _ => null,
        };
        return names.Concat(palette ?? []).Distinct(StringComparer.Ordinal).Select(n => new TypeCandidate<string>(n, n, null)).ToList();
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
                if (ledger.TypeChangesOf(id) is { } changes)
                {
                    results.Add(RestoreTypes(id, changes));
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

    /// <summary>Put back the types a set_type replaced, on the elements that still have the type it gave them.</summary>
    private CommandResult RestoreTypes(string commandId, IReadOnlyList<TypeChange> changes)
    {
        var restored = new List<string>();
        var notes = new List<string>();
        foreach (var c in changes)
        {
            var s = sheets.FirstOrDefault(x => x.Elements.Any(e => e.Id == c.ElementId));
            var i = s?.Elements.FindIndex(e => e.Id == c.ElementId) ?? -1;
            if (s is null || i < 0) notes.Add($"{c.ElementId} is gone");
            else if (s.Elements[i].TypeName != c.To) notes.Add($"{c.ElementId} was changed since, to '{s.Elements[i].TypeName}': left as it is");
            else
            {
                s.Elements[i] = s.Elements[i] with { TypeName = c.From.Length == 0 ? null : c.From };
                restored.Add(c.ElementId);
            }
        }
        ledger.Forget(commandId);
        return restored.Count == 0
            ? CommandResult.Skipped(commandId, notes.Count == 0 ? "no type to put back" : string.Join("; ", notes))
            : CommandResult.Applied(commandId, restored, notes);
    }

    /// <summary>S1-07: the dev host's types: the palette's for walls, doors and furniture, plus the names its category uses.</summary>
    public Task<TypeList> ListTypesAsync(string elementId, CancellationToken ct)
    {
        lock (gate)
        {
            var e = sheets.SelectMany(s => s.Elements).FirstOrDefault(x => x.Id == elementId)
                ?? throw new KeyNotFoundException($"no element '{elementId}'");
            IEnumerable<string> names = e.Category switch
            {
                "Walls" => palette?.Walls?.Select(w => w.Name) ?? [],
                "Doors" => palette?.Doors?.Select(d => d.Name) ?? [],
                "Furniture" => palette?.Furniture?.Select(f => f.Name) ?? [],
                _ => [],
            };
            var all = names
                .Concat(sheets.SelectMany(s => s.Elements).Where(x => x.Category == e.Category).Select(x => x.TypeName).OfType<string>())
                .Where(n => n.Length > 0).Distinct(StringComparer.Ordinal).Select(n => new TypeInfo(null, n, n)).ToList();
            var current = string.IsNullOrEmpty(e.TypeName) ? null : new TypeInfo(null, e.TypeName, e.TypeName);
            return Task.FromResult(new TypeList(elementId, current, all));
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
