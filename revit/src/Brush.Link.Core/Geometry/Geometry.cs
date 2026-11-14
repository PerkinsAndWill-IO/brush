using Brush.Link.Model;

namespace Brush.Link.Geometry;

public readonly record struct Vec2(double X, double Y)
{
    public static Vec2 operator +(Vec2 a, Vec2 b) => new(a.X + b.X, a.Y + b.Y);
    public static Vec2 operator -(Vec2 a, Vec2 b) => new(a.X - b.X, a.Y - b.Y);
    public static Vec2 operator *(Vec2 a, double s) => new(a.X * s, a.Y * s);
    public double Length => Math.Sqrt(X * X + Y * Y);
}

public readonly record struct Vec3(double X, double Y, double Z)
{
    public static Vec3 operator +(Vec3 a, Vec3 b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
    public static Vec3 operator -(Vec3 a, Vec3 b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
    public static Vec3 operator *(Vec3 a, double s) => new(a.X * s, a.Y * s, a.Z * s);
    public double Length => Math.Sqrt(X * X + Y * Y + Z * Z);
    public Vec3 WithZ(double z) => new(X, Y, z);
}

/// <summary>An affine 3D transform in Revit's layout: origin plus three basis vectors (columns).</summary>
public readonly record struct Transform3(Vec3 Origin, Vec3 BasisX, Vec3 BasisY, Vec3 BasisZ)
{
    public static readonly Transform3 Identity = new(new(0, 0, 0), new(1, 0, 0), new(0, 1, 0), new(0, 0, 1));

    public Vec3 OfVector(Vec3 v) => BasisX * v.X + BasisY * v.Y + BasisZ * v.Z;
    public Vec3 OfPoint(Vec3 p) => Origin + OfVector(p);

    /// <summary>this ∘ other: apply <paramref name="other"/> first.</summary>
    public Transform3 Multiply(Transform3 other) =>
        new(OfPoint(other.Origin), OfVector(other.BasisX), OfVector(other.BasisY), OfVector(other.BasisZ));

    public Transform3 Inverse()
    {
        // Columns X,Y,Z; inverse of the 3x3 via the adjugate.
        Vec3 a = BasisX, b = BasisY, c = BasisZ;
        var det = a.X * (b.Y * c.Z - c.Y * b.Z) - b.X * (a.Y * c.Z - c.Y * a.Z) + c.X * (a.Y * b.Z - b.Y * a.Z);
        if (Math.Abs(det) < 1e-15) throw new InvalidOperationException("transform is singular");
        var inv = 1 / det;
        // Rows of the inverse become the columns below (transpose of cofactor matrix).
        var ix = new Vec3((b.Y * c.Z - c.Y * b.Z) * inv, (c.Y * a.Z - a.Y * c.Z) * inv, (a.Y * b.Z - b.Y * a.Z) * inv);
        var iy = new Vec3((c.X * b.Z - b.X * c.Z) * inv, (a.X * c.Z - c.X * a.Z) * inv, (b.X * a.Z - a.X * b.Z) * inv);
        var iz = new Vec3((b.X * c.Y - c.X * b.Y) * inv, (c.X * a.Y - a.X * c.Y) * inv, (a.X * b.Y - b.X * a.Y) * inv);
        var r = new Transform3(new(0, 0, 0), ix, iy, iz);
        var o = r.OfVector(Origin);
        return r with { Origin = new Vec3(-o.X, -o.Y, -o.Z) };
    }
}

/// <summary>Axis-aligned box on a Revit sheet, in sheet feet (y up).</summary>
public readonly record struct SheetBox(double MinU, double MinV, double MaxU, double MaxV)
{
    public double Width => MaxU - MinU;
    public double Height => MaxV - MinV;
    public double Area => Width * Height;
    public bool Contains(Vec2 p, double tol = 1e-9) => p.X >= MinU - tol && p.X <= MaxU + tol && p.Y >= MinV - tol && p.Y <= MaxV + tol;
}

/// <summary>
/// The page frame of a sheet: maps the editor's sheet points (1/72 in, top-left, y down) to Revit sheet feet (y up).
/// <see cref="Page"/> is the title block extent, which is the page of the PDF Revit exports for the sheet.
/// </summary>
public sealed class SheetFrame
{
    public const double PointsPerFoot = 72 * 12;

    public SheetFrame(SheetBox page) => Page = page;

    public SheetBox Page { get; }

    public SheetSize SizePt => new(Round(Page.Width * PointsPerFoot), Round(Page.Height * PointsPerFoot));

    public Vec2 ToSheetFeet(SheetPoint p) => new(Page.MinU + p.X / PointsPerFoot, Page.MaxV - p.Y / PointsPerFoot);

    public SheetPoint ToSheetPoints(Vec2 ft) => new(Round((ft.X - Page.MinU) * PointsPerFoot), Round((Page.MaxV - ft.Y) * PointsPerFoot));

    /// <summary>A direction given as an angle in sheet points (y down) as a unit vector in sheet feet (y up).</summary>
    public static Vec2 DirectionToSheetFeet(double angleRad) => new(Math.Cos(angleRad), -Math.Sin(angleRad));

    private static double Round(double v) => Math.Round(v, 2);
}

/// <summary>
/// One viewport on a sheet, as the core needs it: where it sits on the sheet and how a sheet point maps into the model.
/// The Revit layer builds <see cref="SheetToModel"/> from <c>Viewport.GetProjectionToSheetTransform()</c> and
/// <c>View.GetModelToProjectionTransforms()</c>.
/// </summary>
public sealed record ViewportInfo
{
    public required string ViewId { get; init; }
    public required string ViewName { get; init; }
    /// <summary>Viewport box on the sheet, sheet feet.</summary>
    public required SheetBox Box { get; init; }
    /// <summary>Sheet feet (u, v, 0) to model feet.</summary>
    public required Transform3 SheetToModel { get; init; }
    /// <summary>True for floor and ceiling plans: the only views the planner places elements in.</summary>
    public bool IsPlan { get; init; }
    /// <summary>Scale denominator (100 for 1:100).</summary>
    public double Scale { get; init; }
    public string? LevelId { get; init; }
    /// <summary>Elevation of the view's level, model feet. Model points get this Z.</summary>
    public double LevelElevation { get; init; }

    public Vec3 ToModel(Vec2 sheetFt) => SheetToModel.OfPoint(new Vec3(sheetFt.X, sheetFt.Y, 0)).WithZ(LevelElevation);

    public Vec3 VectorToModel(Vec2 sheetFt)
    {
        var v = SheetToModel.OfVector(new Vec3(sheetFt.X, sheetFt.Y, 0));
        return new Vec3(v.X, v.Y, 0);
    }

    /// <summary>Model point to sheet feet. Depth along the view direction is dropped (a plan projects straight down).</summary>
    public Vec2 ToSheet(Vec3 model)
    {
        var p = SheetToModel.Inverse().OfPoint(model);
        return new Vec2(p.X, p.Y);
    }
}

/// <summary>Everything the planner and exporter need to know about one sheet.</summary>
public sealed record SheetGeometry(SheetFrame Frame, IReadOnlyList<ViewportInfo> Viewports)
{
    /// <summary>The plan viewport under a sheet point: the smallest one containing it (a detail inside a larger plan wins).</summary>
    public ViewportInfo? PlanViewportAt(Vec2 sheetFt) =>
        Viewports.Where(v => v.IsPlan && v.Box.Contains(sheetFt)).OrderBy(v => v.Box.Area).FirstOrDefault();
}
