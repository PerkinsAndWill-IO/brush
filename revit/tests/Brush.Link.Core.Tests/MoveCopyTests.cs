using System.Text.Json;
using Brush.Link.Geometry;
using Brush.Link.Host;
using Brush.Link.Model;
using Brush.Link.Planning;
using Xunit;

namespace Brush.Link.Tests;

/// <summary>S2-05: move and copy in the planner (sheet offsets → model vectors) and in the package host.</summary>
public class MoveCopyPlannerTests
{
    private static readonly JsonSerializerOptions Opts = new(JsonSerializerDefaults.Web);

    /// <summary>A whole-page 1:<paramref name="scale"/> plan viewport on a 3000 x 2000 pt sheet, on a level at <paramref name="elevation"/> ft.</summary>
    private static SheetGeometry Sheet(double scale = 100, string? levelId = "L1", double elevation = 0)
    {
        var frame = new SheetFrame(new SheetBox(0, 0, 3000 / SheetFrame.PointsPerFoot, 2000 / SheetFrame.PointsPerFoot));
        var vp = new ViewportInfo
        {
            ViewId = "v", ViewName = "Plan", Box = frame.Page, IsPlan = true, Scale = scale, LevelId = levelId, LevelElevation = elevation,
            SheetToModel = new Transform3(new(0, 0, 0), new(scale, 0, 0), new(0, scale, 0), new(0, 0, 1)),
        };
        return new SheetGeometry(frame, [vp]);
    }

    [Fact]
    public void S2_05_move_and_copy_parse_and_plan_to_model_vectors()
    {
        const string move = """{"op":"move","id":"cmd-1","sheetId":"A","targets":["wall-42"],"at":{"x":100,"y":1000},"dx":864,"dy":-864,"strokeId":"move:42"}""";
        var m = Assert.IsType<MoveElements>(JsonSerializer.Deserialize<Command>(move, Opts));
        var op = Assert.IsType<MoveOp>(CommandPlanner.Plan(m, Sheet(), _ => false));
        Assert.Equal(["42"], op.HostIds);
        // 864 pt (72 pt/in x 12) = 1 sheet ft = 100 model ft at 1:100; sheet y runs down, model y up
        Assert.Equal(100, op.Translation.X, 6);
        Assert.Equal(100, op.Translation.Y, 6);
        Assert.Equal(0, op.Translation.Z, 6);

        const string copy = """{"op":"copy","id":"cmd-2","sheetId":"A","targets":["42","43"],"at":{"x":100,"y":1000},"toSheetId":"A","to":{"x":964,"y":1000},"strokeId":"copy:1"}""";
        var c = Assert.IsType<CopyElements>(JsonSerializer.Deserialize<Command>(copy, Opts));
        var cop = Assert.IsType<CopyOp>(CommandPlanner.Plan(c, Sheet(), _ => false));
        Assert.Equal(["42", "43"], cop.HostIds);
        Assert.Equal(100, cop.Translation.X, 6);
        Assert.Null(cop.TargetLevelId);
    }

    [Fact]
    public void S2_05_a_point_outside_every_plan_viewport_is_rejected()
    {
        var m = new MoveElements { Id = "cmd-1", SheetId = "A", Targets = ["42"], At = new SheetPoint(5000, 5000), Dx = 1, Dy = 0 };
        Assert.Contains("plan viewport", Assert.IsType<RejectedOp>(CommandPlanner.Plan(m, Sheet(), _ => false)).Reason);
    }

    [Fact]
    public void S2_05_copy_to_another_sheet_uses_that_sheets_viewport_and_level()
    {
        var c = new CopyElements { Id = "cmd-2", SheetId = "A", Targets = ["42"], At = new SheetPoint(0, 2000), ToSheetId = "B", To = new SheetPoint(0, 2000) };
        var other = Sheet(scale: 50, levelId: "L2", elevation: 12);
        var op = Assert.IsType<CopyOp>(CommandPlanner.Plan(c, Sheet(), _ => false, id => id == "B" ? other : null));
        // both points are each sheet's model origin: no plan shift, 12 ft up to the other level
        Assert.Equal(0, op.Translation.X, 6);
        Assert.Equal(0, op.Translation.Y, 6);
        Assert.Equal(12, op.Translation.Z, 6);
        Assert.Equal("L2", op.TargetLevelId);
        Assert.IsType<RejectedOp>(CommandPlanner.Plan(c with { ToSheetId = "Z" }, Sheet(), _ => false, _ => null));
    }
}

public class MoveCopyHostTests
{
    private static PackageHost Host() => PackageHost.FromFile(Path.Combine(AppContext.BaseDirectory, "fixtures", "office-1-sheet.drawing"));

    private static async Task<ManifestElement[]> ElementsAsync(PackageHost h, string id) =>
        (await h.ExportSheetAsync("A-201", CancellationToken.None)).Sheet.Elements.Where(e => e.Id == id).ToArray();

    [Fact]
    public async Task S2_05_move_then_revert_restores_the_footprint()
    {
        var h = Host();
        var before = (await ElementsAsync(h, "100000")).Single().Footprint.ToList();
        var r = await h.ApplyAsync("A-201", [new MoveElements { Id = "cmd-m", SheetId = "A-201", Targets = ["100000"], At = before[0], Dx = 30, Dy = -10 }], CancellationToken.None);
        Assert.Equal(CommandStatus.Applied, Assert.Single(r).Status);
        var moved = (await ElementsAsync(h, "100000")).Single().Footprint;
        Assert.Equal(before[0].X + 30, moved[0].X, 6);
        Assert.Equal(before[0].Y - 10, moved[0].Y, 6);
        Assert.Equal(CommandStatus.Applied, Assert.Single(await h.RevertAsync(["cmd-m"], CancellationToken.None)).Status);
        Assert.Equal(before, (await ElementsAsync(h, "100000")).Single().Footprint);
    }

    [Fact]
    public async Task S2_05_copy_then_revert_deletes_the_copies()
    {
        var h = Host();
        var count = (await h.ExportSheetAsync("A-201", CancellationToken.None)).Sheet.Elements.Count;
        var src = (await ElementsAsync(h, "100000")).Single();
        var r = Assert.Single(await h.ApplyAsync("A-201", [new CopyElements { Id = "cmd-c", SheetId = "A-201", Targets = ["100000"], At = src.Footprint[0], ToSheetId = "A-201", To = new SheetPoint(src.Footprint[0].X + 40, src.Footprint[0].Y) }], CancellationToken.None));
        Assert.Equal(CommandStatus.Applied, r.Status);
        var copyId = Assert.Single(r.ElementIds);
        var copy = (await ElementsAsync(h, copyId)).Single();
        Assert.Equal(src.Category, copy.Category);
        Assert.Equal(src.Footprint[0].X + 40, copy.Footprint[0].X, 6);
        Assert.Equal(count + 1, (await h.ExportSheetAsync("A-201", CancellationToken.None)).Sheet.Elements.Count);
        Assert.Equal(CommandStatus.Applied, Assert.Single(await h.RevertAsync(["cmd-c"], CancellationToken.None)).Status);
        Assert.Equal(count, (await h.ExportSheetAsync("A-201", CancellationToken.None)).Sheet.Elements.Count);
    }
}
