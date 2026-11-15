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

/// <summary>S1: switch <see cref="HostIds"/> to the type named by <see cref="TypeId"/>, else by family + type name.</summary>
public sealed record ChangeTypeOp(string CommandId, IReadOnlyList<string> HostIds, string? Family, string TypeName, string? TypeId) : ModelOp(CommandId);

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

    /// <param name="sheet">The sheet the command was drawn on; null for a view page (S1-06), where only ops that need no sheet
    /// geometry (delete, set_type) can be planned.</param>
    public static ModelOp Plan(Command command, SheetGeometry? sheet, Func<string, bool> isKnownCommand)
    {
        try
        {
            return command switch
            {
                CreateWall or PlaceDoor or PlaceInstance when sheet is null => new RejectedOp(command.Id, NotOnASheet(command)),
                CreateWall c => PlanWall(c, sheet!),
                PlaceDoor c => PlanDoor(c, sheet!, isKnownCommand),
                PlaceInstance c => PlanInstance(c, sheet!),
                DeleteElements c => PlanDelete(c, isKnownCommand),
                SetType c => PlanChangeType(c),
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

    private static string NotOnASheet(Command c) =>
        $"{c.Id}: not on a sheet: {c.Op} needs a plan viewport on a sheet; on a view page only delete and set_type apply";

    private static ModelOp PlanChangeType(SetType c)
    {
        var host = c.Targets.Select(HostId).OfType<string>().Distinct(StringComparer.Ordinal).ToList();
        if (host.Count == 0) return new RejectedOp(c.Id, $"no target names a Revit element: {string.Join(", ", c.Targets)}");
        if (string.IsNullOrWhiteSpace(c.TypeName) && c.TypeId is null) return new RejectedOp(c.Id, "no type named");
        return new ChangeTypeOp(c.Id, host, c.Family, c.TypeName, c.TypeId);
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

    /// <summary>A Revit element id from a hostRef ("123456") or a package context item id ("wall-123456"); null otherwise.</summary>
    public static string? HostId(string? reference)
    {
        if (string.IsNullOrEmpty(reference)) return null;
        if (ElementIdPattern().IsMatch(reference)) return reference;
        var m = ContextItemPattern().Match(reference);
        return m.Success ? m.Groups[1].Value : null;
    }
}
