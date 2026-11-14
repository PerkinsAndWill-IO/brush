using System.Globalization;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Brush.Link.Geometry;
using Brush.Link.Model;

namespace Brush.Revit;

/// <summary>
/// Reads a sheet out of Revit: its page frame and viewports (for placing commands), its elements as manifest entries,
/// the type palette, and the sheet as PDF. API thread only.
/// </summary>
internal static class SheetReader
{
    public const double MmPerFoot = 304.8;

    public static string IdOf(Element e) => e.Id.Value.ToString(CultureInfo.InvariantCulture);

    public static ElementId? ParseId(string? s) =>
        long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? new ElementId(v) : null;

    public static IEnumerable<ViewSheet> Sheets(Document doc) =>
        new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>()
            .Where(s => !s.IsPlaceholder && !s.IsTemplate)
            .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase);

    public static ViewSheet FindSheet(Document doc, string sheetId) =>
        (ParseId(sheetId) is { } id ? doc.GetElement(id) as ViewSheet : null)
        ?? throw new KeyNotFoundException($"no sheet with id '{sheetId}' in {doc.Title}");

    // ─────────────── geometry ───────────────

    public static Vec3 V(XYZ p) => new(p.X, p.Y, p.Z);

    public static XYZ X(Vec3 v) => new(v.X, v.Y, v.Z);

    private static Transform3 T(Transform t) => new(V(t.Origin), V(t.BasisX), V(t.BasisY), V(t.BasisZ));

    /// <summary>
    /// The page is the title block's extent: that is the page Revit's PDF export produces for the sheet. Without a
    /// title block, the sheet outline.
    /// </summary>
    public static SheetFrame FrameOf(ViewSheet sheet)
    {
        var tb = new FilteredElementCollector(sheet.Document, sheet.Id).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType().FirstElement();
        if (tb?.get_BoundingBox(sheet) is { } bb)
            return new SheetFrame(new SheetBox(bb.Min.X, bb.Min.Y, bb.Max.X, bb.Max.Y));
        var o = sheet.Outline;
        return new SheetFrame(new SheetBox(o.Min.U, o.Min.V, o.Max.U, o.Max.V));
    }

    public static SheetGeometry GeometryOf(ViewSheet sheet)
    {
        var doc = sheet.Document;
        var viewports = new List<ViewportInfo>();
        foreach (var vpId in sheet.GetAllViewports())
        {
            if (doc.GetElement(vpId) is not Viewport vp || doc.GetElement(vp.ViewId) is not View view) continue;
            var projections = view.GetModelToProjectionTransforms();
            if (projections.Count == 0) continue;
            // A view with a split crop region has one transform per region; v1 uses the first (see README limits).
            var modelToSheet = vp.GetProjectionToSheetTransform().Multiply(projections[0].GetModelToProjectionTransform());
            var box = vp.GetBoxOutline();
            var level = (view as ViewPlan)?.GenLevel;
            viewports.Add(new ViewportInfo
            {
                ViewId = IdOf(view),
                ViewName = view.Name,
                Box = new SheetBox(box.MinimumPoint.X, box.MinimumPoint.Y, box.MaximumPoint.X, box.MaximumPoint.Y),
                SheetToModel = T(modelToSheet.Inverse),
                IsPlan = view.ViewType is ViewType.FloorPlan or ViewType.CeilingPlan or ViewType.AreaPlan or ViewType.EngineeringPlan,
                Scale = view.Scale,
                LevelId = level is null ? null : IdOf(level),
                LevelElevation = level?.ProjectElevation ?? 0,
            });
        }
        return new SheetGeometry(FrameOf(sheet), viewports);
    }

    // ─────────────── manifest ───────────────

    private static readonly BuiltInCategory[] Exported =
    [
        BuiltInCategory.OST_Walls, BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows, BuiltInCategory.OST_Rooms,
        BuiltInCategory.OST_Furniture, BuiltInCategory.OST_Casework, BuiltInCategory.OST_Grids,
    ];

    public static ManifestSheet ManifestOf(ViewSheet sheet)
    {
        var doc = sheet.Document;
        var geometry = GeometryOf(sheet);
        var frame = geometry.Frame;
        var elements = new List<ManifestElement>();
        var seen = new HashSet<long>();
        foreach (var vp in geometry.Viewports.Where(v => v.IsPlan))
        {
            var viewId = ParseId(vp.ViewId)!;
            var view = (View)doc.GetElement(viewId);
            List<SheetPoint> ToSheet(IEnumerable<XYZ> pts) => pts.Select(p => frame.ToSheetPoints(vp.ToSheet(V(p)))).ToList();

            var collector = new FilteredElementCollector(doc, viewId).WherePasses(new ElementMulticategoryFilter(Exported)).WhereElementIsNotElementType();
            foreach (var e in collector)
            {
                if (!seen.Add(e.Id.Value)) continue;
                var m = Describe(e, view, ToSheet);
                if (m is { Footprint.Count: > 0 }) elements.Add(m);
            }
        }
        var main = geometry.Viewports.Where(v => v.IsPlan).OrderByDescending(v => v.Box.Area).FirstOrDefault();
        return new ManifestSheet
        {
            Id = IdOf(sheet),
            Number = sheet.SheetNumber,
            Name = sheet.Name,
            SizePt = frame.SizePt,
            Scale = main?.Scale,
            Elements = elements,
        };
    }

    private static ManifestElement? Describe(Element e, View view, Func<IEnumerable<XYZ>, List<SheetPoint>> toSheet)
    {
        var id = IdOf(e);
        switch (e)
        {
            case Wall w when w.Location is LocationCurve lc:
                return new ManifestElement
                {
                    Id = id, Category = "Walls", TypeName = w.WallType.Name, Footprint = toSheet(lc.Curve.Tessellate()),
                    Props = new Dictionary<string, string> { ["thicknessMm"] = Mm(w.Width), ["level"] = LevelName(e) },
                };
            case Grid g:
                return new ManifestElement { Id = id, Category = "Grids", Label = g.Name, Footprint = toSheet(g.Curve.Tessellate()) };
            case Room r when r.Area > 0:
            {
                var loops = r.GetBoundarySegments(new SpatialElementBoundaryOptions());
                if (loops is null || loops.Count == 0) return null;
                var pts = loops[0].SelectMany(s => s.GetCurve().Tessellate().SkipLast(1));
                var name = r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString();
                return new ManifestElement { Id = id, Category = "Rooms", Label = $"{name} {r.Number}".Trim(), Closed = true, Footprint = toSheet(pts) };
            }
            case FamilyInstance fi when fi.Category?.BuiltInCategory is BuiltInCategory.OST_Doors or BuiltInCategory.OST_Windows:
            {
                if (fi.Location is not LocationPoint lp) return null;
                var width = TypeWidth(fi.Symbol) ?? 3;
                var along = fi.HandOrientation;
                var half = along.Multiply(width / 2);
                var cat = fi.Category.BuiltInCategory == BuiltInCategory.OST_Doors ? "Doors" : "Windows";
                var props = new Dictionary<string, string> { ["widthMm"] = Mm(width), ["level"] = LevelName(e) };
                if (fi.Host is Wall host) props["hostWall"] = IdOf(host);
                return new ManifestElement { Id = id, Category = cat, TypeName = KeyOf(fi.Symbol), Footprint = toSheet([lp.Point - half, lp.Point + half]), Props = props };
            }
            case FamilyInstance fi:
            {
                var corners = FootprintOf(fi, view);
                if (corners is null) return null;
                var cat = fi.Category?.BuiltInCategory == BuiltInCategory.OST_Casework ? "Casework" : "Furniture";
                return new ManifestElement { Id = id, Category = cat, TypeName = KeyOf(fi.Symbol), Closed = true, Footprint = toSheet(corners), Props = new Dictionary<string, string> { ["level"] = LevelName(e) } };
            }
            default:
                return null;
        }
    }

    /// <summary>The instance's plan footprint: its symbol geometry's box, turned and placed like the instance. Falls back to the axis-aligned box.</summary>
    private static XYZ[]? FootprintOf(FamilyInstance fi, View view)
    {
        foreach (var g in fi.get_Geometry(new Options { View = view }) ?? Enumerable.Empty<GeometryObject>())
        {
            if (g is GeometryInstance gi && gi.GetSymbolGeometry()?.GetBoundingBox() is { } sb)
            {
                var t = gi.Transform;
                return [t.OfPoint(new XYZ(sb.Min.X, sb.Min.Y, 0)), t.OfPoint(new XYZ(sb.Max.X, sb.Min.Y, 0)), t.OfPoint(new XYZ(sb.Max.X, sb.Max.Y, 0)), t.OfPoint(new XYZ(sb.Min.X, sb.Max.Y, 0))];
            }
        }
        if (fi.get_BoundingBox(view) is not { } bb) return null;
        return [new XYZ(bb.Min.X, bb.Min.Y, 0), new XYZ(bb.Max.X, bb.Min.Y, 0), new XYZ(bb.Max.X, bb.Max.Y, 0), new XYZ(bb.Min.X, bb.Max.Y, 0)];
    }

    private static string LevelName(Element e) => e.Document.GetElement(e.LevelId) is Level l ? l.Name : "";

    private static string Mm(double feet) => Math.Round(feet * MmPerFoot).ToString(CultureInfo.InvariantCulture);

    // ─────────────── types ───────────────

    /// <summary>
    /// How a family type is named to the editor and back: "Family: Type". Commands may also name just the type;
    /// <see cref="CommandApplier"/> accepts both.
    /// </summary>
    public static string KeyOf(FamilySymbol s) => $"{s.FamilyName}: {s.Name}";

    public static double? TypeWidth(FamilySymbol s) =>
        Param(s, BuiltInParameter.DOOR_WIDTH) ?? Param(s, BuiltInParameter.WINDOW_WIDTH) ?? Param(s, BuiltInParameter.FAMILY_WIDTH_PARAM) ?? Param(s, BuiltInParameter.GENERIC_WIDTH);

    public static double? TypeDepth(FamilySymbol s) => Param(s, BuiltInParameter.GENERIC_DEPTH);

    public static double? TypeHeight(FamilySymbol s) => Param(s, BuiltInParameter.DOOR_HEIGHT) ?? Param(s, BuiltInParameter.FAMILY_HEIGHT_PARAM);

    private static double? Param(Element e, BuiltInParameter p) =>
        e.get_Parameter(p) is { StorageType: StorageType.Double, HasValue: true } param && param.AsDouble() > 0 ? param.AsDouble() : null;

    public static IEnumerable<FamilySymbol> Symbols(Document doc, BuiltInCategory cat) =>
        new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).OfCategory(cat).Cast<FamilySymbol>().OrderBy(KeyOf, StringComparer.OrdinalIgnoreCase);

    public static IEnumerable<WallType> BasicWallTypes(Document doc) =>
        new FilteredElementCollector(doc).OfClass(typeof(WallType)).Cast<WallType>().Where(t => t.Kind == WallKind.Basic).OrderBy(t => t.Name, StringComparer.OrdinalIgnoreCase);

    public static TypePalette PaletteOf(Document doc) => new()
    {
        Walls = BasicWallTypes(doc).Select(t => new WallTypeDef(t.Name, Math.Round(t.Width * MmPerFoot))).ToList(),
        Doors = Symbols(doc, BuiltInCategory.OST_Doors).Select(s => new DoorFamilyDef(KeyOf(s), Math.Round((TypeWidth(s) ?? 0) * MmPerFoot), TypeHeight(s) is { } h ? Math.Round(h * MmPerFoot) : null)).ToList(),
        Furniture = Symbols(doc, BuiltInCategory.OST_Furniture).Select(s => new FurnitureFamilyDef(KeyOf(s), Math.Round((TypeWidth(s) ?? 0) * MmPerFoot), Math.Round((TypeDepth(s) ?? 0) * MmPerFoot))).ToList(),
    };

    // ─────────────── PDF ───────────────

    /// <summary>The sheet as a one-page PDF at its own paper size. Outside any transaction.</summary>
    public static byte[] PdfOf(ViewSheet sheet)
    {
        var dir = Path.Combine(Path.GetTempPath(), "brush-link", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var options = new PDFExportOptions
            {
                FileName = "sheet",
                Combine = true,
                PaperFormat = ExportPaperFormat.Default, // the sheet's own size, so PDF page = title block
                ZoomType = ZoomType.Zoom,
                ZoomPercentage = 100,
                HideCropBoundaries = true,
                HideScopeBoxes = true,
                HideReferencePlane = true,
                HideUnreferencedViewTags = true,
                ColorDepth = ColorDepthType.Color,
            };
            if (!sheet.Document.Export(dir, new List<ElementId> { sheet.Id }, options))
                throw new InvalidOperationException($"Revit could not export sheet {sheet.SheetNumber} to PDF");
            var file = Directory.GetFiles(dir, "*.pdf").FirstOrDefault() ?? throw new InvalidOperationException("PDF export wrote no file");
            return File.ReadAllBytes(file);
        }
        finally
        {
            try
            {
                Directory.Delete(dir, true);
            }
            catch (IOException)
            {
            }
        }
    }
}
