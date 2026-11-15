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
            // S2: a copy pasted on another sheet maps through that sheet's plan viewport
            var op = CommandPlanner.Plan(c, geometry, ledger.Knows, id => SheetReader.ParseId(id) is { } sid && doc.GetElement(sid) is ViewSheet vs ? SheetReader.GeometryOf(vs) : null);
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
            if (ledger.MovesOf(id) is { } moves)
            {
                // S2: every element the move touched goes back where it was (the moved ones and the walls that followed)
                var back = InTransaction($"Brush: undo {id}", () => RestoreLocations(moves));
                if (back.Status == CommandStatus.Applied) ledger.Forget(id);
                results.Add(back with { Id = id });
                continue;
            }
            if (ledger.TypeChangesOf(id) is { } changes)
            {
                var restored = InTransaction($"Brush: undo {id}", () => RestoreTypes(changes));
                if (restored.Status == CommandStatus.Applied) ledger.Forget(id);
                results.Add(restored.Status == CommandStatus.Applied && restored.ElementIds.Count == 0
                    ? CommandResult.Skipped(id, restored.Notes is { Count: > 0 } n ? string.Join("; ", n) : "no type to put back")
                    : restored with { Id = id });
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
        var typeChanges = new List<TypeChange>();
        var moved = new List<MovedElement>();
        var r = InTransaction($"Brush: {id}", () => op switch
        {
            WallOp w => Walls(w),
            DoorOp d => Door(d),
            InstanceOp i => Instance(i),
            DeleteOp x => Delete(x),
            SetTypeOp t => SetTypes(t, typeChanges),
            MoveOp m => Move(m, moved),
            CopyOp k => Copy(k),
            _ => throw new InvalidOperationException($"no executor for {op.GetType().Name}"),
        });
        r = r with { Id = id };
        if (r.Status != CommandStatus.Applied) return r;
        if (op is SetTypeOp) ledger.RecordTypeChanges(id, typeChanges);
        else if (op is MoveOp) ledger.RecordMoves(id, moved);
        else ledger.Record(id, op is DeleteOp ? Array.Empty<string>() : r.ElementIds);
        return r;
    }

    // ─────────────── S2: move and copy ───────────────

    private static string Num(double v) => v.ToString("R", System.Globalization.CultureInfo.InvariantCulture);

    private static string Num(long v) => v.ToString(System.Globalization.CultureInfo.InvariantCulture);

    private static double Parse(string s) => double.Parse(s, System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>
    /// Where an element is: <c>L|x0|y0|z0|x1|y1|z1</c> for a straight location line, <c>P|x|y|z|rotation</c> for a point;
    /// null for anything else (curved walls, elements without a location), which revert then cannot put back.
    /// </summary>
    private static string? LocationText(Element e) => e.Location switch
    {
        LocationCurve { Curve: Line l } => $"L|{Num(l.GetEndPoint(0).X)}|{Num(l.GetEndPoint(0).Y)}|{Num(l.GetEndPoint(0).Z)}|{Num(l.GetEndPoint(1).X)}|{Num(l.GetEndPoint(1).Y)}|{Num(l.GetEndPoint(1).Z)}",
        LocationPoint p => $"P|{Num(p.Point.X)}|{Num(p.Point.Y)}|{Num(p.Point.Z)}|{Num(p.Rotation)}",
        _ => null,
    };

    /// <summary>
    /// <c>MoveElements</c> by the op's vector. Joined walls follow (Revit's default) and hosted doors and windows go
    /// with their wall; every element that can move (targets, and walls joined at a moved wall's ends) has its location
    /// recorded first, so revert puts it back exactly.
    /// </summary>
    private (List<string>, List<string>) Move(MoveOp op, List<MovedElement> before)
    {
        var notes = new List<string>();
        var ids = new List<ElementId>();
        foreach (var hostId in op.HostIds)
        {
            if (SheetReader.ParseId(hostId) is { } eid && doc.GetElement(eid) is { } e) ids.Add(e.Id);
            else notes.Add($"no element {hostId} in this model");
        }
        if (ids.Count == 0) throw new InvalidOperationException(string.Join("; ", notes));
        var touched = new HashSet<ElementId>(ids);
        foreach (var id in ids)
            if (doc.GetElement(id) is Wall { Location: LocationCurve lc })
                for (var end = 0; end < 2; end++)
                    foreach (Element j in lc.get_ElementsAtJoin(end))
                        if (j is Wall) touched.Add(j.Id);
        foreach (var id in touched)
        {
            var e = doc.GetElement(id);
            if (LocationText(e) is { } loc) before.Add(new MovedElement(SheetReader.IdOf(e), loc));
            else if (ids.Contains(id)) notes.Add($"{SheetReader.IdOf(e)} has no straight location: undo cannot put it back exactly");
        }
        var v = op.Translation;
        ElementTransformUtils.MoveElements(doc, ids, new XYZ(v.X, v.Y, v.Z));
        return (ids.Select(id => Num(id.Value)).ToList(), notes);
    }

    /// <summary>Revert of a move: each recorded element back to its recorded location (gone ones are a note).</summary>
    private (List<string>, List<string>) RestoreLocations(IReadOnlyList<MovedElement> moves)
    {
        var notes = new List<string>();
        var back = new List<string>();
        foreach (var m in moves)
        {
            if (SheetReader.ParseId(m.ElementId) is not { } eid || doc.GetElement(eid) is not { } e)
            {
                notes.Add($"{m.ElementId} is gone");
                continue;
            }
            var f = m.Location.Split('|');
            if (f[0] == "L" && e.Location is LocationCurve lc)
                lc.Curve = Line.CreateBound(new XYZ(Parse(f[1]), Parse(f[2]), Parse(f[3])), new XYZ(Parse(f[4]), Parse(f[5]), Parse(f[6])));
            else if (f[0] == "P" && e.Location is LocationPoint lp)
            {
                lp.Point = new XYZ(Parse(f[1]), Parse(f[2]), Parse(f[3]));
                var turn = Parse(f[4]) - lp.Rotation;
                if (Math.Abs(turn) > 1e-9) lp.Rotate(Line.CreateBound(lp.Point, lp.Point + XYZ.BasisZ), turn);
            }
            else continue;
            back.Add(m.ElementId);
        }
        if (back.Count == 0) throw new InvalidOperationException(notes.Count > 0 ? string.Join("; ", notes) : "nothing to put back");
        return (back, notes);
    }

    /// <summary>
    /// <c>CopyElements</c>: the targets, with the doors and windows a copied wall hosts. On another level's plan the copies
    /// are made flat (no Z) and then given that level, which keeps their offsets.
    /// </summary>
    private (List<string>, List<string>) Copy(CopyOp op)
    {
        var notes = new List<string>();
        var ids = new HashSet<ElementId>();
        foreach (var hostId in op.HostIds)
        {
            if (SheetReader.ParseId(hostId) is not { } eid || doc.GetElement(eid) is not { } e)
            {
                notes.Add($"no element {hostId} in this model");
                continue;
            }
            ids.Add(e.Id);
            if (e is Wall w)
                foreach (var ins in w.FindInserts(false, false, false, false))
                    if (doc.GetElement(ins) is FamilyInstance) ids.Add(ins);
        }
        if (ids.Count == 0) throw new InvalidOperationException(string.Join("; ", notes));
        var v = op.Translation;
        var level = op.TargetLevelId is { } lid && SheetReader.ParseId(lid) is { } lvid ? doc.GetElement(lvid) as Level : null;
        var copies = ElementTransformUtils.CopyElements(doc, ids.ToList(), new XYZ(v.X, v.Y, level is null ? v.Z : 0));
        if (level is not null)
            foreach (var cid in copies)
                if (!SetLevel(doc.GetElement(cid), level)) notes.Add($"{Num(cid.Value)} kept its level (no level parameter to set)");
        return (copies.Select(id => id.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToList(), notes);
    }

    /// <summary>Put a copy on <paramref name="level"/>, keeping its offsets: a wall's base constraint, an instance's level.</summary>
    private static bool SetLevel(Element e, Level level)
    {
        if (e is Wall)
        {
            // keep its height: a top tied to a level ("up to Level 2") could end up below the new base
            var height = e.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.AsDouble();
            var top = e.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE);
            if (top is { IsReadOnly: false } && top.AsElementId() != ElementId.InvalidElementId) top.Set(ElementId.InvalidElementId);
            if (height is > 0 && e.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM) is { IsReadOnly: false } hp) hp.Set(height.Value);
        }
        var p = e switch
        {
            Wall => e.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT),
            FamilyInstance { Host: Wall } => null, // a hosted door or window follows its copied wall
            _ => e.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM) ?? e.get_Parameter(BuiltInParameter.INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM),
        };
        if (e is FamilyInstance { Host: Wall }) return true;
        if (p is null || p.IsReadOnly) return false;
        return p.Set(level.Id);
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

    /// <summary>
    /// <c>ChangeTypeId</c> on each target, to the type <see cref="TypeMatch"/> picks among the element's valid types
    /// (same category, and same kind for walls). A target that cannot change is a note; when none can, the command fails.
    /// </summary>
    private (List<string>, List<string>) SetTypes(SetTypeOp op, List<TypeChange> changes)
    {
        var notes = new List<string>();
        var errors = new List<string>();
        var touched = new List<string>();
        if (op.Unresolved.Count > 0) notes.Add($"ignored targets that name no Revit element: {string.Join(", ", op.Unresolved)}");
        foreach (var hostId in op.HostIds)
        {
            if (SheetReader.ParseId(hostId) is not { } eid || doc.GetElement(eid) is not { } e)
            {
                errors.Add($"no element {hostId} in this model");
                continue;
            }
            var what = e.Category?.Name ?? "element";
            var m = TypeMatch.Find(TypesFor(e), op.TypeName, op.Family, what.ToLowerInvariant());
            var hit = m.Hit;
            if (hit is null)
            {
                errors.Add($"{hostId}: {m.Error}");
                continue;
            }
            var type = hit.Value;
            if (m.Note is not null && !notes.Contains(m.Note)) notes.Add(m.Note);
            touched.Add(hostId);
            var from = e.GetTypeId();
            if (from == type.Id)
            {
                notes.Add($"{hostId} is already '{hit.Key}'");
                continue;
            }
            if (type is FamilySymbol { IsActive: false } fs) fs.Activate();
            e.ChangeTypeId(type.Id);
            changes.Add(new TypeChange(hostId, Str(from), Str(type.Id)));
        }
        if (touched.Count == 0) throw new InvalidOperationException(string.Join("; ", errors));
        notes.AddRange(errors);
        return (touched, notes);
    }

    /// <summary>The types the element can take: <see cref="Element.GetValidTypes()"/>, else every type of its category.</summary>
    private List<TypeCandidate<ElementType>> TypesFor(Element e)
    {
        var ids = e.GetValidTypes();
        var types = ids is { Count: > 0 }
            ? ids.Select(id => doc.GetElement(id)).OfType<ElementType>()
            : e.Category is { } cat ? new FilteredElementCollector(doc).OfCategoryId(cat.Id).WhereElementIsElementType().OfType<ElementType>() : Enumerable.Empty<ElementType>();
        return types
            .Select(t => new TypeCandidate<ElementType>(t, t.Name, t is FamilySymbol ? t.FamilyName : null))
            .OrderBy(c => c.Key, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>Revert of a set_type: back to the old type on each element that still has the type the command gave it.</summary>
    private (List<string>, List<string>) RestoreTypes(IReadOnlyList<TypeChange> changes)
    {
        var restored = new List<string>();
        var notes = new List<string>();
        foreach (var c in changes)
        {
            var e = SheetReader.ParseId(c.ElementId) is { } id ? doc.GetElement(id) : null;
            var from = SheetReader.ParseId(c.From);
            if (e is null) notes.Add($"{c.ElementId} is gone");
            else if (Str(e.GetTypeId()) != c.To) notes.Add($"{c.ElementId} was given another type since: left as it is");
            else if (from is null || doc.GetElement(from) is not ElementType old) notes.Add($"{c.ElementId}: its old type is gone from the model");
            else
            {
                if (old is FamilySymbol { IsActive: false } fs) fs.Activate();
                e.ChangeTypeId(old.Id);
                restored.Add(c.ElementId);
            }
        }
        return (restored, notes);
    }

    private static string Str(ElementId id) => id.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);

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
