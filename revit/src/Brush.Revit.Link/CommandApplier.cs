using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Brush.Link.Geometry;
using Brush.Link.Host;
using Brush.Link.Model;
using Brush.Link.Planning;

namespace Brush.Revit;

/// <summary>
/// Executes planned commands in a document. API thread only.
///
/// One <see cref="TransactionGroup"/> per batch (one Undo step in Revit), one <see cref="Transaction"/> per command
/// inside it, so a command Revit rejects rolls back alone and the others stay. Warnings are swallowed (they would
/// otherwise open dialogs mid-batch); errors roll back that command and come back as its message.
/// </summary>
internal sealed class CommandApplier(Document doc, CommandLedger ledger)
{
    /// <summary>A door snaps to a wall whose centreline is within this distance of where it was drawn (model feet).</summary>
    public const double DoorSnapFt = 2.0;

    /// <summary>Wall height when the level has no level above it.</summary>
    public const double DefaultWallHeightFt = 10.0;

    public IReadOnlyList<CommandResult> Apply(ViewSheet sheet, string sheetId, IReadOnlyList<Command> commands)
    {
        var geometry = SheetReader.GeometryOf(sheet);
        var results = new List<CommandResult>();
        using var group = new TransactionGroup(doc, $"Brush: {commands.Count} edit{(commands.Count == 1 ? "" : "s")} from the editor");
        group.Start();
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
            results.Add(op is RejectedOp r ? CommandResult.Failed(c.Id, r.Reason) : Run(c.Id, op));
        }
        if (results.Any(r => r.Status == CommandStatus.Applied)) group.Assimilate();
        else group.RollBack();
        return results;
    }

    public IReadOnlyList<CommandResult> Revert(IReadOnlyList<string> commandIds)
    {
        var results = new List<CommandResult>();
        using var group = new TransactionGroup(doc, "Brush: undo from the editor");
        group.Start();
        foreach (var id in commandIds)
        {
            if (!ledger.Knows(id))
            {
                results.Add(CommandResult.Skipped(id, "not a command of this link session"));
                continue;
            }
            var created = ledger.ElementsOf(id).Select(SheetReader.ParseId).OfType<ElementId>().Where(e => doc.GetElement(e) is not null).ToList();
            if (created.Count == 0)
            {
                ledger.Forget(id);
                results.Add(CommandResult.Skipped(id, "nothing left to remove (a delete cannot be undone from the editor; use Undo in Revit)"));
                continue;
            }
            var r = InTransaction($"Brush: undo {id}", () =>
            {
                doc.Delete(created);
                return (created.Select(e => e.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToList(), new List<string>());
            });
            if (r.Status == CommandStatus.Applied) ledger.Forget(id);
            results.Add(r with { Id = id });
        }
        if (results.Any(r => r.Status == CommandStatus.Applied)) group.Assimilate();
        else group.RollBack();
        return results;
    }

    private CommandResult Run(string id, ModelOp op)
    {
        var r = InTransaction($"Brush: {id}", () => op switch
        {
            WallOp w => Walls(w),
            DoorOp d => Door(d),
            InstanceOp i => Instance(i),
            DeleteOp x => Delete(x),
            _ => throw new InvalidOperationException($"no executor for {op.GetType().Name}"),
        });
        r = r with { Id = id };
        if (r.Status == CommandStatus.Applied) ledger.Record(id, op is DeleteOp ? Array.Empty<string>() : r.ElementIds);
        return r;
    }

    private CommandResult InTransaction(string name, Func<(List<string> elements, List<string> notes)> work)
    {
        using var t = new Transaction(doc, name);
        var failures = new FailureCollector();
        var fho = t.GetFailureHandlingOptions();
        fho.SetFailuresPreprocessor(failures);
        fho.SetClearAfterRollback(true);
        t.SetFailureHandlingOptions(fho);
        t.Start();
        (List<string> elements, List<string> notes) result;
        try
        {
            result = work();
        }
        catch (Exception e) when (e is Autodesk.Revit.Exceptions.ApplicationException or InvalidOperationException or ArgumentException)
        {
            t.RollBack();
            return CommandResult.Failed("", e.Message);
        }
        var status = t.Commit();
        if (status != TransactionStatus.Committed)
            return CommandResult.Failed("", failures.Errors.Count > 0 ? string.Join("; ", failures.Errors) : $"Revit did not commit ({status})");
        result.notes.AddRange(failures.Warnings.Select(w => $"Revit warning: {w}"));
        return CommandResult.Applied("", result.elements, result.notes);
    }

    // ─────────────── ops ───────────────

    private (List<string>, List<string>) Walls(WallOp op)
    {
        var notes = new List<string>();
        var level = LevelOf(op.LevelId, op.ViewId);
        var type = ResolveWallType(op.WallType, notes);
        var height = HeightAbove(level);
        var ids = new List<string>();
        foreach (var (a, b) in op.Segments)
        {
            var line = Line.CreateBound(SheetReader.X(a.WithZ(level.ProjectElevation)), SheetReader.X(b.WithZ(level.ProjectElevation)));
            var wall = Wall.Create(doc, line, type.Id, level.Id, height, 0, false, false);
            ids.Add(SheetReader.IdOf(wall));
        }
        return (ids, notes);
    }

    private (List<string>, List<string>) Door(DoorOp op)
    {
        var notes = new List<string>();
        var level = LevelOf(op.LevelId, op.ViewId);
        var at = SheetReader.X(op.At.WithZ(level.ProjectElevation));
        var wall = HostWall(op.HostWallRef, at)
            ?? NearestWall(op.ViewId, at, notes)
            ?? throw new InvalidOperationException($"no wall within {DoorSnapFt} ft of the door to host it");
        var curve = ((LocationCurve)wall.Location).Curve;
        var onWall = curve.Project(at)?.XYZPoint ?? at;
        var symbol = ResolveSymbol(BuiltInCategory.OST_Doors, op.FamilyType, op.WidthFt, null, notes) ?? throw new InvalidOperationException("no door family is loaded in this model");
        if (!symbol.IsActive) symbol.Activate();
        var wallLevel = doc.GetElement(wall.LevelId) as Level ?? level;
        var door = doc.Create.NewFamilyInstance(new XYZ(onWall.X, onWall.Y, wallLevel.ProjectElevation), symbol, wall, wallLevel, StructuralType.NonStructural);
        var typeWidth = SheetReader.TypeWidth(symbol);
        if (typeWidth is { } tw && Math.Abs(tw - op.WidthFt) > 0.1 * op.WidthFt)
            notes.Add($"drawn {Math.Round(op.WidthFt * SheetReader.MmPerFoot)} mm wide, placed '{SheetReader.KeyOf(symbol)}' ({Math.Round(tw * SheetReader.MmPerFoot)} mm)");
        return ([SheetReader.IdOf(door)], notes);
    }

    private (List<string>, List<string>) Instance(InstanceOp op)
    {
        var notes = new List<string>();
        var level = LevelOf(op.LevelId, op.ViewId);
        var symbol = ResolveSymbol(BuiltInCategory.OST_Furniture, op.Family, op.WidthFt, op.DepthFt, notes) ?? throw new InvalidOperationException("no furniture family is loaded in this model");
        if (!symbol.IsActive) symbol.Activate();
        var at = SheetReader.X(op.At.WithZ(level.ProjectElevation));
        var fi = doc.Create.NewFamilyInstance(at, symbol, level, StructuralType.NonStructural);
        if (Math.Abs(op.RotationRad) > 1e-6)
            ElementTransformUtils.RotateElement(doc, fi.Id, Line.CreateBound(at, at + XYZ.BasisZ), op.RotationRad);
        return ([SheetReader.IdOf(fi)], notes);
    }

    private (List<string>, List<string>) Delete(DeleteOp op)
    {
        var notes = new List<string>();
        var ids = op.HostIds.Concat(op.CommandIds.SelectMany(ledger.ElementsOf))
            .Select(SheetReader.ParseId).OfType<ElementId>().Distinct().Where(id => doc.GetElement(id) is not null).ToList();
        if (ids.Count == 0) throw new InvalidOperationException("the targets are already gone");
        if (op.Unresolved.Count > 0) notes.Add($"ignored targets that name no Revit element: {string.Join(", ", op.Unresolved)}");
        var deleted = doc.Delete(ids);
        if (deleted.Count > ids.Count) notes.Add($"Revit also removed {deleted.Count - ids.Count} dependent element(s) (doors in a deleted wall, tags)");
        return (ids.Select(i => i.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToList(), notes);
    }

    // ─────────────── lookups ───────────────

    private Level LevelOf(string? levelId, string viewId)
    {
        if (SheetReader.ParseId(levelId) is { } id && doc.GetElement(id) is Level l) return l;
        if (SheetReader.ParseId(viewId) is { } vid && doc.GetElement(vid) is ViewPlan { GenLevel: { } gl }) return gl;
        throw new InvalidOperationException("the viewport's view has no level");
    }

    private double HeightAbove(Level level)
    {
        var above = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
            .Where(l => l.ProjectElevation > level.ProjectElevation + 1e-6).OrderBy(l => l.ProjectElevation).FirstOrDefault();
        return above is null ? DefaultWallHeightFt : above.ProjectElevation - level.ProjectElevation;
    }

    /// <summary>
    /// The wall a door names: a Revit element id, or a create_wall command of this link (one wall per segment; the
    /// segment nearest the door).
    /// </summary>
    private Wall? HostWall(string? reference, XYZ at)
    {
        if (reference is null) return null;
        var ids = ledger.Knows(reference) ? ledger.ElementsOf(reference) : [reference];
        return ids.Select(SheetReader.ParseId).OfType<ElementId>().Select(id => doc.GetElement(id)).OfType<Wall>()
            .Where(w => w.Location is LocationCurve)
            .OrderBy(w => ((LocationCurve)w.Location).Curve.Project(new XYZ(at.X, at.Y, ((LocationCurve)w.Location).Curve.GetEndPoint(0).Z))?.Distance ?? double.MaxValue)
            .FirstOrDefault();
    }

    private Wall? NearestWall(string viewId, XYZ at, List<string> notes)
    {
        var vid = SheetReader.ParseId(viewId);
        var walls = vid is null ? new FilteredElementCollector(doc) : new FilteredElementCollector(doc, vid);
        Wall? best = null;
        var bestD = DoorSnapFt;
        foreach (var w in walls.OfClass(typeof(Wall)).Cast<Wall>())
        {
            if (w.Location is not LocationCurve lc) continue;
            var flat = new XYZ(at.X, at.Y, lc.Curve.GetEndPoint(0).Z);
            var d = lc.Curve.Project(flat)?.Distance ?? double.MaxValue;
            if (d < bestD) (best, bestD) = (w, d);
        }
        if (best is not null) notes.Add($"hosted in the nearest wall {SheetReader.IdOf(best)}");
        return best;
    }

    private WallType ResolveWallType(string? name, List<string> notes)
    {
        var types = SheetReader.BasicWallTypes(doc).ToList();
        if (name is not null)
        {
            var hit = types.FirstOrDefault(t => t.Name == name) ?? types.FirstOrDefault(t => string.Equals(t.Name, name, StringComparison.OrdinalIgnoreCase));
            if (hit is not null) return hit;
        }
        var fallback = doc.GetElement(doc.GetDefaultElementTypeId(ElementTypeGroup.WallType)) as WallType ?? types.FirstOrDefault()
            ?? throw new InvalidOperationException("no basic wall type in this model");
        if (name is not null) notes.Add($"no wall type '{name}', used '{fallback.Name}'");
        return fallback;
    }

    /// <summary>By key ("Family: Type"), then by type name, then the closest in size; null when none is loaded.</summary>
    private FamilySymbol? ResolveSymbol(BuiltInCategory cat, string? name, double widthFt, double? depthFt, List<string> notes)
    {
        var symbols = SheetReader.Symbols(doc, cat).ToList();
        if (symbols.Count == 0) return null;
        if (name is not null)
        {
            var hit = symbols.FirstOrDefault(s => SheetReader.KeyOf(s) == name)
                ?? symbols.FirstOrDefault(s => s.Name == name)
                ?? symbols.FirstOrDefault(s => string.Equals(SheetReader.KeyOf(s), name, StringComparison.OrdinalIgnoreCase) || string.Equals(s.Name, name, StringComparison.OrdinalIgnoreCase));
            if (hit is not null) return hit;
        }
        double Miss(FamilySymbol s) =>
            Math.Abs((SheetReader.TypeWidth(s) ?? 0) - widthFt) + (depthFt is { } d ? Math.Abs((SheetReader.TypeDepth(s) ?? 0) - d) : 0);
        var best = symbols.OrderBy(Miss).First();
        notes.Add(name is null ? $"no type given, used the closest in size: '{SheetReader.KeyOf(best)}'" : $"no type '{name}', used the closest in size: '{SheetReader.KeyOf(best)}'");
        return best;
    }

    /// <summary>Deletes warnings so no dialog opens mid-batch, and rolls back on errors, keeping their text.</summary>
    private sealed class FailureCollector : IFailuresPreprocessor
    {
        public List<string> Warnings { get; } = [];
        public List<string> Errors { get; } = [];

        public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
        {
            var rollback = false;
            foreach (var f in accessor.GetFailureMessages())
            {
                if (f.GetSeverity() == FailureSeverity.Warning)
                {
                    Warnings.Add(f.GetDescriptionText());
                    accessor.DeleteWarning(f);
                }
                else
                {
                    Errors.Add(f.GetDescriptionText());
                    rollback = true;
                }
            }
            return rollback ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
        }
    }
}
