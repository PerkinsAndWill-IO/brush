using System.Text.Json;
using Brush.Link.Geometry;
using Brush.Link.Model;
using Brush.Link.Planning;
using Xunit;

namespace Brush.Link.Tests;

public class GeometryTests
{
    [Fact]
    public void Transform_inverse_round_trips()
    {
        var t = new Transform3(new(10, -4, 3), new(0, 50, 0), new(-50, 0, 0), new(0, 0, 1));
        var p = new Vec3(1.25, -0.5, 2);
        var back = t.Inverse().OfPoint(t.OfPoint(p));
        Assert.Equal(p.X, back.X, 9);
        Assert.Equal(p.Y, back.Y, 9);
        Assert.Equal(p.Z, back.Z, 9);
    }

    [Fact]
    public void Sheet_frame_maps_top_left_y_down_points_to_sheet_feet()
    {
        // An A1 title block whose lower-left corner sits at (-0.1, 0.2) sheet feet.
        var f = new SheetFrame(new SheetBox(-0.1, 0.2, -0.1 + 2.7559, 0.2 + 1.9488));
        var topLeft = f.ToSheetFeet(new SheetPoint(0, 0));
        Assert.Equal(-0.1, topLeft.X, 9);
        Assert.Equal(0.2 + 1.9488, topLeft.Y, 9);
        var bottomRight = f.ToSheetFeet(new SheetPoint(f.SizePt.W, f.SizePt.H));
        Assert.Equal(-0.1 + 2.7559, bottomRight.X, 2);
        Assert.Equal(0.2, bottomRight.Y, 2);
        Assert.Equal(new SheetPoint(144, 72), f.ToSheetPoints(f.ToSheetFeet(new SheetPoint(144, 72))));
    }
}

public class PlannerTests
{
    /// <summary>A 1:100 plan viewport, its box from (0.5,0.5) to (2,1.5) sheet ft, model origin at the box's lower-left, level at 12 ft.</summary>
    private static SheetGeometry Sheet(double rotateViewRad = 0)
    {
        var frame = new SheetFrame(new SheetBox(0, 0, 3, 2));
        var (c, s) = (Math.Cos(rotateViewRad), Math.Sin(rotateViewRad));
        // Sheet ft → model ft: translate box corner to origin, scale ×100, rotate (a rotated plan on the sheet).
        var linear = new Transform3(new(0, 0, 0), new(100 * c, 100 * s, 0), new(-100 * s, 100 * c, 0), new(0, 0, 1));
        var toModel = linear.Multiply(new Transform3(new(-0.5, -0.5, 0), new(1, 0, 0), new(0, 1, 0), new(0, 0, 1)));
        var vp = new ViewportInfo
        {
            ViewId = "v1", ViewName = "Level 2", Box = new SheetBox(0.5, 0.5, 2, 1.5), SheetToModel = toModel,
            IsPlan = true, Scale = 100, LevelId = "L2", LevelElevation = 12,
        };
        var legend = new ViewportInfo { ViewId = "legend", ViewName = "Legend", Box = new SheetBox(2.2, 0.1, 2.9, 1.9), SheetToModel = Transform3.Identity };
        return new SheetGeometry(frame, [vp, legend]);
    }

    private static SheetPoint Pt(double sheetFtX, double sheetFtY) => new(sheetFtX * 864, (2 - sheetFtY) * 864);

    [Fact]
    public void Wall_points_land_in_model_feet_on_the_view_level()
    {
        var cmd = new CreateWall { Id = "cmd-0001", SheetId = "s", Path = new SheetPath([Pt(0.5, 0.5), Pt(1.5, 0.5), Pt(1.5, 1.0)], false), WallType = "Generic - 200mm" };
        var op = Assert.IsType<WallOp>(CommandPlanner.Plan(cmd, Sheet(), _ => false));
        Assert.Equal("L2", op.LevelId);
        Assert.Equal(2, op.Segments.Count);
        Assert.Equal(new Vec3(0, 0, 12), Round(op.Segments[0].A));
        Assert.Equal(new Vec3(100, 0, 12), Round(op.Segments[0].B));
        Assert.Equal(new Vec3(100, 50, 12), Round(op.Segments[1].B));
        Assert.Equal("Generic - 200mm", op.WallType);
    }

    [Fact]
    public void Closed_wall_path_adds_the_closing_segment_and_drops_zero_length_ones()
    {
        var cmd = new CreateWall { Id = "c", SheetId = "s", Path = new SheetPath([Pt(0.6, 0.6), Pt(0.6, 0.6), Pt(1.6, 0.6), Pt(1.6, 1.2)], true) };
        var op = Assert.IsType<WallOp>(CommandPlanner.Plan(cmd, Sheet(), _ => false));
        Assert.Equal(3, op.Segments.Count);
        Assert.Equal(Round(op.Segments[0].A), Round(op.Segments[2].B));
    }

    [Fact]
    public void Door_width_scales_from_paper_to_model_and_direction_follows_y_down()
    {
        // 9 mm on paper at 1:100 is a 900 mm door. Angle -90° in y-down sheet points is "up the page".
        var widthPt = 9 / 25.4 * 72;
        var cmd = new PlaceDoor { Id = "d", SheetId = "s", At = Pt(1, 1), WidthPt = widthPt, AngleRad = -Math.PI / 2, HostWallRef = "wall-123456" };
        var op = Assert.IsType<DoorOp>(CommandPlanner.Plan(cmd, Sheet(), _ => false));
        Assert.Equal(0.9 / 0.3048, op.WidthFt, 6);
        Assert.Equal(0, op.Direction.X, 9);
        Assert.Equal(1, op.Direction.Y, 9);
        Assert.Equal("123456", op.HostWallRef);
        Assert.Equal(new Vec3(50, 50, 12), Round(op.At));
    }

    [Fact]
    public void A_door_may_name_a_wall_created_earlier_by_its_command_id()
    {
        var cmd = new PlaceDoor { Id = "d", SheetId = "s", At = Pt(1, 1), WidthPt = 20, AngleRad = 0, HostWallRef = "cmd-0001" };
        Assert.Equal("cmd-0001", Assert.IsType<DoorOp>(CommandPlanner.Plan(cmd, Sheet(), id => id == "cmd-0001")).HostWallRef);
        Assert.Null(Assert.IsType<DoorOp>(CommandPlanner.Plan(cmd, Sheet(), _ => false)).HostWallRef);
    }

    [Fact]
    public void A_rotated_view_rotates_instances_in_the_model()
    {
        var cmd = new PlaceInstance { Id = "f", SheetId = "s", At = Pt(1, 1), Bbox = new SheetRect(0, 0, 16, 8), AngleRad = 0, Family = "Desk 1600x800" };
        var op = Assert.IsType<InstanceOp>(CommandPlanner.Plan(cmd, Sheet(rotateViewRad: Math.PI / 2), _ => false));
        Assert.Equal(Math.PI / 2, op.RotationRad, 9);
        Assert.Equal(16.0 / 864 * 100, op.WidthFt, 9);
        Assert.Equal(8.0 / 864 * 100, op.DepthFt, 9);
    }

    [Fact]
    public void Commands_outside_a_plan_viewport_are_rejected_with_a_reason()
    {
        var onLegend = new PlaceDoor { Id = "d", SheetId = "s", At = Pt(2.5, 1), WidthPt = 20, AngleRad = 0 };
        var r = Assert.IsType<RejectedOp>(CommandPlanner.Plan(onLegend, Sheet(), _ => false));
        Assert.Contains("plan viewport", r.Reason);
    }

    [Fact]
    public void Delete_sorts_targets_into_elements_commands_and_unresolved()
    {
        var cmd = new DeleteElements { Id = "x", SheetId = "s", Targets = ["140005", "wall-140006", "cmd-0003", "w4-5"] };
        var op = Assert.IsType<DeleteOp>(CommandPlanner.Plan(cmd, Sheet(), id => id == "cmd-0003"));
        Assert.Equal(["140005", "140006"], op.HostIds);
        Assert.Equal(["cmd-0003"], op.CommandIds);
        Assert.Equal(["w4-5"], op.Unresolved);
    }

    [Fact]
    public void Delete_of_only_inferred_ids_is_rejected()
    {
        var cmd = new DeleteElements { Id = "x", SheetId = "s", Targets = ["w4-5"] };
        Assert.IsType<RejectedOp>(CommandPlanner.Plan(cmd, Sheet(), _ => false));
    }

    [Theory]
    [InlineData("123456", "123456")]
    [InlineData("wall-123456", "123456")]
    [InlineData("fixture-42", "42")]
    [InlineData("cmd-0001", null)] // an unknown command id is not element 1
    [InlineData("sheet-3", null)]
    [InlineData("w4-5", null)]
    public void Host_ids_come_only_from_element_ids_and_package_context_ids(string reference, string? expected) =>
        Assert.Equal(expected, CommandPlanner.HostId(reference));

    private static Vec3 Round(Vec3 v) => new(Math.Round(v.X, 6), Math.Round(v.Y, 6), Math.Round(v.Z, 6));
}

public class CommandJsonTests
{
    // Shapes exactly as editor/src/core/commands commandFromDecision builds them (key order varies on purpose).
    private const string EditorBatch = """
    [
      {"op":"create_wall","id":"cmd-0001","sheetId":"A-201","path":{"points":[{"x":100,"y":120},{"x":400,"y":120}],"closed":false},"strokeId":"s1","wallType":"Generic - 200mm"},
      {"id":"cmd-0002","sheetId":"A-201","op":"place_door","at":{"x":200,"y":120},"widthPt":25.5,"angleRad":0,"strokeId":"s2","hostWallRef":"100000"},
      {"op":"place_instance","id":"cmd-0003","sheetId":"A-201","at":{"x":300,"y":300},"bbox":{"x":277,"y":289,"w":46,"h":22},"angleRad":0.5,"strokeId":"s3","family":"Desk 1600x800"},
      {"op":"delete","id":"cmd-0004","sheetId":"A-201","targets":["100001"],"strokeId":"s4"},
      {"op":"rename_room","id":"cmd-0005","sheetId":"A-201","strokeId":"s5"}
    ]
    """;

    [Fact]
    public void Reads_the_editors_command_shapes()
    {
        var cmds = JsonSerializer.Deserialize<List<Command>>(EditorBatch, Json.Options)!;
        var wall = Assert.IsType<CreateWall>(cmds[0]);
        Assert.Equal(2, wall.Path.Points.Count);
        Assert.Equal("Generic - 200mm", wall.WallType);
        var door = Assert.IsType<PlaceDoor>(cmds[1]);
        Assert.Equal(new SheetPoint(200, 120), door.At);
        Assert.Equal("100000", door.HostWallRef);
        var inst = Assert.IsType<PlaceInstance>(cmds[2]);
        Assert.Equal(46, inst.Bbox.W);
        Assert.Equal(["100001"], Assert.IsType<DeleteElements>(cmds[3]).Targets);
        Assert.Equal("rename_room", Assert.IsType<UnknownCommand>(cmds[4]).Op);
    }

    [Fact]
    public void Writes_what_it_reads()
    {
        var cmds = JsonSerializer.Deserialize<List<Command>>(EditorBatch, Json.Options)!;
        var again = JsonSerializer.Deserialize<List<Command>>(JsonSerializer.Serialize(cmds, Json.Options), Json.Options)!;
        Assert.Equal(JsonSerializer.Serialize(cmds, Json.Options), JsonSerializer.Serialize(again, Json.Options));
        Assert.StartsWith("""[{"op":"create_wall","id":"cmd-0001","sheetId":"A-201","strokeId":"s1","path":""", JsonSerializer.Serialize(cmds, Json.Options));
    }

    [Theory]
    [InlineData("""{"op":"place_door","id":"d","sheetId":"s","widthPt":3,"angleRad":0}""", "missing at")]
    [InlineData("""{"op":"create_wall","id":"w","path":{"points":[],"closed":false}}""", "missing sheetId")]
    [InlineData("""{"op":"place_door","id":"d","sheetId":"s","at":{"x":1},"widthPt":3,"angleRad":0}""", "bad point")]
    public void Missing_fields_name_the_problem(string json, string expected)
    {
        var e = Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Command>(json, Json.Options));
        Assert.Contains(expected, e.Message);
    }
}

public class PackageTests
{
    [Fact]
    public void Reads_the_editor_fixture_and_writes_an_envelope_the_editor_reads()
    {
        var (m, name, pdf) = DrawingPackage.Parse(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "fixtures", "office-1-sheet.drawing")));
        Assert.Equal("A-201", m.Sheets[0].Id);
        Assert.NotEmpty(m.Sheets[0].Elements);
        Assert.NotNull(m.Palette?.Walls);
        Assert.NotNull(pdf);

        var bytes = DrawingPackage.Serialize(m, name, pdf);
        using var doc = JsonDocument.Parse(bytes);
        var root = doc.RootElement;
        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal("base64", root.GetProperty("pdf").GetProperty("encoding").GetString());
        Assert.Equal(1191, root.GetProperty("sheets")[0].GetProperty("sizePt").GetProperty("w").GetDouble());
        // Nulls are omitted, as the editor writes them.
        Assert.False(root.GetProperty("sheets")[0].GetProperty("elements")[0].TryGetProperty("label", out _));
        var (m2, _, pdf2) = DrawingPackage.Parse(bytes);
        Assert.Equal(m.Sheets[0].Elements.Count, m2.Sheets[0].Elements.Count);
        Assert.Equal(pdf, pdf2);
    }
}
