using System.Text.RegularExpressions;
using Brush.Link.Geometry;
using Brush.Link.Model;

namespace Brush.Link.Planning;

/// <summary>
/// A command translated into model space, ready for the host to execute. Pure data: no Revit types, so the
/// translation (the part that is easy to get wrong) is unit-tested without Revit.
/// </summary>
public abstract record ModelOp(string CommandId);

/// <summary>One straight wall per segment of the editor's path (a closed path adds the closing segment).</summary>
public sealed record WallOp(string CommandId, string ViewId, string? LevelId, IReadOnlyList<(Vec3 A, Vec3 B)> Segments, string? WallType) : ModelOp(CommandId);

/// <summary>
/// A door at <see cref="At"/>, opening <see cref="WidthFt"/> wide along <see cref="Direction"/> (unit, model XY).
/// <see cref="HostWallRef"/> is a Revit element id, an earlier command id of this link, or null (nearest wall).
/// </summary>
public sealed record DoorOp(string CommandId, string ViewId, string? LevelId, Vec3 At, double WidthFt, Vec3 Direction, string? HostWallRef, string? FamilyType) : ModelOp(CommandId);

/// <summary>A family instance centred at <see cref="At"/>, rotated <see cref="RotationRad"/> counter-clockwise about Z.</summary>
public sealed record InstanceOp(string CommandId, string ViewId, string? LevelId, Vec3 At, double RotationRad, double WidthFt, double DepthFt, string? Family) : ModelOp(CommandId);

/// <summary>
/// Delete: <see cref="HostIds"/> are Revit element ids, <see cref="CommandIds"/> earlier commands of this link whose
/// elements go, <see cref="Unresolved"/> targets that name neither (inferred ids from a plain PDF).
/// </summary>
public sealed record DeleteOp(string CommandId, IReadOnlyList<string> HostIds, IReadOnlyList<string> CommandIds, IReadOnlyList<string> Unresolved) : ModelOp(CommandId);

/// <summary>
/// Set type: give each of <see cref="HostIds"/> (Revit element ids) the type named <see cref="TypeName"/>, of
/// <see cref="Family"/> when given. <see cref="Unresolved"/> are targets that name no element.
/// </summary>
public sealed record SetTypeOp(string CommandId, IReadOnlyList<string> HostIds, IReadOnlyList<string> Unresolved, string TypeName, string? Family) : ModelOp(CommandId);

/// <summary>S2: move the elements by a model vector (feet), through the plan viewport under the grab point.</summary>
public sealed record MoveOp(string CommandId, IReadOnlyList<string> HostIds, Vec3 Translation) : ModelOp(CommandId);

/// <summary>
/// S2: copy the elements by a model vector. <see cref="TargetLevelId"/>: the level the copies take when pasted on another
/// level's plan (null on the same level); the vector's Z is then the difference between the two levels.
/// </summary>
public sealed record CopyOp(string CommandId, IReadOnlyList<string> HostIds, Vec3 Translation, string? TargetLevelId) : ModelOp(CommandId);

/// <summary>A command the planner could not translate; the reason goes back to the editor.</summary>
public sealed record RejectedOp(string CommandId, string Reason) : ModelOp(CommandId);

public static partial class CommandPlanner
{
    [GeneratedRegex(@"^\d+$")]
    private static partial Regex ElementIdPattern();

    /// <summary>
    /// Editor context item ids for package elements are <c>{kind}-{hostId}</c> (kinds from <c>ContextItemKind</c>).
    /// Only those kinds: a command id such as <c>cmd-0001</c> must never be read as element 1.
    /// </summary>
    [GeneratedRegex(@"^(?:wall|opening|grid|label|fixture|unknown)-(\d+)$")]
    private static partial Regex ContextItemPattern();

    /// <param name="geometryOf">S2: another sheet's geometry, for a copy pasted on another sheet; null when unknown.</param>
    public static ModelOp Plan(Command command, SheetGeometry sheet, Func<string, bool> isKnownCommand, Func<string, SheetGeometry?>? geometryOf = null)
    {
        try
        {
            return command switch
            {
                MoveElements c => PlanMove(c, sheet),
                CopyElements c => PlanCopy(c, sheet, geometryOf),
                CreateWall c => PlanWall(c, sheet),
                PlaceDoor c => PlanDoor(c, sheet, isKnownCommand),
                PlaceInstance c => PlanInstance(c, sheet),
                DeleteElements c => PlanDelete(c, isKnownCommand),
                SetType c => PlanSetType(c),
                UnknownCommand c => new RejectedOp(c.Id, $"unknown op '{c.RawOp}'"),
                _ => new RejectedOp(command.Id, $"unsupported op '{command.Op}'"),
            };
        }
        catch (InvalidOperationException e)
        {
            return new RejectedOp(command.Id, e.Message);
        }
    }

    private static ViewportInfo ViewportFor(SheetGeometry sheet, Vec2 sheetFt, string commandId) =>
        sheet.PlanViewportAt(sheetFt) ?? throw new InvalidOperationException($"{commandId}: not inside a plan viewport on this sheet");

    private static ModelOp PlanWall(CreateWall c, SheetGeometry sheet)
    {
        var pts = c.Path.Points;
        if (pts.Count < 2) return new RejectedOp(c.Id, "wall path needs at least two points");
        var ft = pts.Select(sheet.Frame.ToSheetFeet).ToList();
        // One viewport for the whole wall: the one under its first point. A wall drawn across two viewports is
        // still one wall in the model, so it must use one transform.
        var vp = ViewportFor(sheet, ft[0], c.Id);
        var model = ft.Select(vp.ToModel).ToList();
        var segs = new List<(Vec3, Vec3)>();
        for (var i = 0; i + 1 < model.Count; i++) AddSegment(segs, model[i], model[i + 1]);
        if (c.Path.Closed && model.Count > 2) AddSegment(segs, model[^1], model[0]);
        if (segs.Count == 0) return new RejectedOp(c.Id, "wall path has no length");
        return new WallOp(c.Id, vp.ViewId, vp.LevelId, segs, c.WallType);
    }

    /// <summary>Revit rejects curves shorter than about 1/32 in (its short-curve tolerance); skip those segments.</summary>
    public const double MinSegmentFt = 1.0 / 384;

    private static void AddSegment(List<(Vec3, Vec3)> segs, Vec3 a, Vec3 b)
    {
        if ((b - a).Length >= MinSegmentFt) segs.Add((a, b));
    }

    private static ModelOp PlanDoor(PlaceDoor c, SheetGeometry sheet, Func<string, bool> isKnownCommand)
    {
        // The host wall may be a Revit element, or a wall this link created earlier (named by its command id).
        var host = c.HostWallRef is { } r && isKnownCommand(r) ? r : HostId(c.HostWallRef);
        var at = sheet.Frame.ToSheetFeet(c.At);
        var vp = ViewportFor(sheet, at, c.Id);
        var dir = SheetFrame.DirectionToSheetFeet(c.AngleRad) * (c.WidthPt / SheetFrame.PointsPerFoot);
        var modelDir = vp.VectorToModel(dir);
        var width = modelDir.Length;
        if (width <= 0) return new RejectedOp(c.Id, "door has no width");
        return new DoorOp(c.Id, vp.ViewId, vp.LevelId, vp.ToModel(at), width, modelDir * (1 / width), host, c.FamilyType);
    }

    private static ModelOp PlanInstance(PlaceInstance c, SheetGeometry sheet)
    {
        var at = sheet.Frame.ToSheetFeet(c.At);
        var vp = ViewportFor(sheet, at, c.Id);
        // bbox is the footprint in its own unrotated frame: w along the instance's x axis, h along its y axis.
        var ux = SheetFrame.DirectionToSheetFeet(c.AngleRad);
        var uy = SheetFrame.DirectionToSheetFeet(c.AngleRad + Math.PI / 2);
        var mx = vp.VectorToModel(ux * (c.Bbox.W / SheetFrame.PointsPerFoot));
        var my = vp.VectorToModel(uy * (c.Bbox.H / SheetFrame.PointsPerFoot));
        if (mx.Length <= 0 || my.Length <= 0) return new RejectedOp(c.Id, "instance footprint has no area");
        return new InstanceOp(c.Id, vp.ViewId, vp.LevelId, vp.ToModel(at), Math.Atan2(mx.Y, mx.X), mx.Length, my.Length, c.Family);
    }

    private static ModelOp PlanDelete(DeleteElements c, Func<string, bool> isKnownCommand)
    {
        var host = new List<string>();
        var cmds = new List<string>();
        var unresolved = new List<string>();
        foreach (var t in c.Targets)
        {
            if (isKnownCommand(t)) cmds.Add(t);
            else if (HostId(t) is { } id) host.Add(id);
            else unresolved.Add(t);
        }
        if (host.Count == 0 && cmds.Count == 0) return new RejectedOp(c.Id, $"no target names a Revit element or an earlier command: {string.Join(", ", c.Targets)}");
        return new DeleteOp(c.Id, host, cmds, unresolved);
    }

    private static List<string> HostIdsOf(IReadOnlyList<string> targets) =>
        targets.Select(HostId).OfType<string>().Distinct(StringComparer.Ordinal).ToList();

    private static ModelOp PlanMove(MoveElements c, SheetGeometry sheet)
    {
        var host = HostIdsOf(c.Targets);
        if (host.Count == 0) return new RejectedOp(c.Id, $"no target names a Revit element: {string.Join(", ", c.Targets)}");
        var from = sheet.Frame.ToSheetFeet(c.At);
        var vp = ViewportFor(sheet, from, c.Id);
        var to = sheet.Frame.ToSheetFeet(new SheetPoint(c.At.X + c.Dx, c.At.Y + c.Dy));
        return new MoveOp(c.Id, host, vp.ToModel(to) - vp.ToModel(from));
    }

    private static ModelOp PlanCopy(CopyElements c, SheetGeometry sheet, Func<string, SheetGeometry?>? geometryOf)
    {
        var host = HostIdsOf(c.Targets);
        if (host.Count == 0) return new RejectedOp(c.Id, $"no target names a Revit element: {string.Join(", ", c.Targets)}");
        var from = sheet.Frame.ToSheetFeet(c.At);
        var vp = ViewportFor(sheet, from, c.Id);
        var target = c.ToSheetId == c.SheetId ? sheet : geometryOf?.Invoke(c.ToSheetId);
        if (target is null) return new RejectedOp(c.Id, $"{c.Id}: no sheet '{c.ToSheetId}' to paste on");
        var tvp = ViewportFor(target, target.Frame.ToSheetFeet(c.To), c.Id);
        var level = tvp.LevelId is { } l && l != vp.LevelId ? l : null;
        return new CopyOp(c.Id, host, tvp.ToModel(target.Frame.ToSheetFeet(c.To)) - vp.ToModel(from), level);
    }

    private static ModelOp PlanSetType(SetType c)
    {
        var host = new List<string>();
        var unresolved = new List<string>();
        foreach (var t in c.Targets)
        {
            if (HostId(t) is { } id) { if (!host.Contains(id)) host.Add(id); }
            else unresolved.Add(t);
        }
        if (host.Count == 0)
            return new RejectedOp(c.Id, c.Targets.Count == 0 ? "set_type has no targets" : $"no target names a Revit element: {string.Join(", ", c.Targets)}");
        return new SetTypeOp(c.Id, host, unresolved, c.TypeName, c.Family);
    }

    /// <summary>
    /// The type name and family to look for. The sheet names a family type <c>Family: Type</c> (and the editor may
    /// send that as <c>typeName</c> with or without <c>family</c>), so a <c>typeName</c> that starts with
    /// <c>family + ": "</c> is cut to the type name.
    /// </summary>
    public static (string Name, string? Family) TypeQuery(string typeName, string? family) =>
        family is { Length: > 0 } f && typeName.StartsWith(f + ": ", StringComparison.Ordinal) ? (typeName[(f.Length + 2)..], f) : (typeName, family);

    /// <summary>A Revit element id from a hostRef ("123456") or a package context item id ("wall-123456"); null otherwise.</summary>
    public static string? HostId(string? reference)
    {
        if (string.IsNullOrEmpty(reference)) return null;
        if (ElementIdPattern().IsMatch(reference)) return reference;
        var m = ContextItemPattern().Match(reference);
        return m.Success ? m.Groups[1].Value : null;
    }
}
