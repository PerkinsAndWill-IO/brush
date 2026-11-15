using System.Text.Json;
using System.Text.Json.Serialization;

namespace Brush.Link.Model;

/// <summary>A point in sheet points (1/72 in), origin top-left, y down. Same as the editor's <c>core/types</c> Point.</summary>
public readonly record struct SheetPoint(double X, double Y);

public sealed record SheetPath(IReadOnlyList<SheetPoint> Points, bool Closed);

public readonly record struct SheetRect(double X, double Y, double W, double H);

/// <summary>
/// Mirror of the editor's <c>Command</c> union (<c>editor/src/core/types/index.ts</c>, decision 0005).
/// The JSON shape is the editor's exactly; <see cref="CommandJsonConverter"/> dispatches on <c>op</c> in any key order.
/// </summary>
[JsonConverter(typeof(CommandJsonConverter))]
public abstract record Command
{
    public required string Id { get; init; }
    public required string SheetId { get; init; }
    public string? StrokeId { get; init; }
    public abstract string Op { get; }
}

public sealed record CreateWall : Command
{
    public override string Op => "create_wall";
    public required SheetPath Path { get; init; }
    public string? WallType { get; init; }
    public string? HostRef { get; init; }
}

public sealed record PlaceDoor : Command
{
    public override string Op => "place_door";
    public required SheetPoint At { get; init; }
    public required double WidthPt { get; init; }
    public required double AngleRad { get; init; }
    public string? HostWallRef { get; init; }
    public string? FamilyType { get; init; }
}

public sealed record PlaceInstance : Command
{
    public override string Op => "place_instance";
    public required SheetPoint At { get; init; }
    public required SheetRect Bbox { get; init; }
    public required double AngleRad { get; init; }
    public string? Family { get; init; }
}

public sealed record DeleteElements : Command
{
    public override string Op => "delete";
    public required IReadOnlyList<string> Targets { get; init; }
}

/// <summary>
/// Change the type of host elements already on the sheet (editor decision 0011). <see cref="Targets"/> are Revit
/// element ids; <see cref="TypeName"/> is the type as the sheet names it (<c>ManifestElement.TypeName</c>: a wall
/// type's name, or <c>Family: Type</c> for a family instance), <see cref="Family"/> its family when the editor knows it.
/// The editor sends one per element, with <c>strokeId</c> <c>type:&lt;element id&gt;</c>.
/// </summary>
public sealed record SetType : Command
{
    public override string Op => "set_type";
    public required IReadOnlyList<string> Targets { get; init; }
    public required string TypeName { get; init; }
    public string? Family { get; init; }
}

/// <summary>An op this plugin does not know. Kept so the reply can say "skipped" for it instead of failing the batch.</summary>
public sealed record UnknownCommand : Command
{
    public required string RawOp { get; init; }
    public override string Op => RawOp;
}

public sealed class CommandJsonConverter : JsonConverter<Command>
{
    public override Command Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var doc = JsonDocument.ParseValue(ref reader);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new JsonException("command is not an object");
        var op = root.TryGetProperty("op", out var o) && o.ValueKind == JsonValueKind.String ? o.GetString()! : "";
        Command? cmd = op switch
        {
            "create_wall" => root.Deserialize<CreateWallDto>(options)?.ToCommand(),
            "place_door" => root.Deserialize<PlaceDoorDto>(options)?.ToCommand(),
            "place_instance" => root.Deserialize<PlaceInstanceDto>(options)?.ToCommand(),
            "delete" => root.Deserialize<DeleteDto>(options)?.ToCommand(),
            "set_type" => root.Deserialize<SetTypeDto>(options)?.ToCommand(),
            _ => root.Deserialize<BaseDto>(options) is { } b ? new UnknownCommand { Id = b.Id ?? "", SheetId = b.SheetId ?? "", StrokeId = b.StrokeId, RawOp = op } : null,
        };
        return cmd ?? throw new JsonException($"command with op '{op}' is empty");
    }

    public override void Write(Utf8JsonWriter writer, Command value, JsonSerializerOptions options)
    {
        object dto = value switch
        {
            CreateWall c => new CreateWallDto { Op = c.Op, Id = c.Id, SheetId = c.SheetId, StrokeId = c.StrokeId, Path = new PathDto { Points = c.Path.Points.Select(PointDto.Of).ToList(), Closed = c.Path.Closed }, WallType = c.WallType, HostRef = c.HostRef },
            PlaceDoor c => new PlaceDoorDto { Op = c.Op, Id = c.Id, SheetId = c.SheetId, StrokeId = c.StrokeId, At = PointDto.Of(c.At), WidthPt = c.WidthPt, AngleRad = c.AngleRad, HostWallRef = c.HostWallRef, FamilyType = c.FamilyType },
            PlaceInstance c => new PlaceInstanceDto { Op = c.Op, Id = c.Id, SheetId = c.SheetId, StrokeId = c.StrokeId, At = PointDto.Of(c.At), Bbox = RectDto.Of(c.Bbox), AngleRad = c.AngleRad, Family = c.Family },
            DeleteElements c => new DeleteDto { Op = c.Op, Id = c.Id, SheetId = c.SheetId, StrokeId = c.StrokeId, Targets = c.Targets.ToList() },
            SetType c => new SetTypeDto { Op = c.Op, Id = c.Id, SheetId = c.SheetId, StrokeId = c.StrokeId, Targets = c.Targets.ToList(), TypeName = c.TypeName, Family = c.Family },
            _ => new BaseDto { Op = value.Op, Id = value.Id, SheetId = value.SheetId, StrokeId = value.StrokeId },
        };
        JsonSerializer.Serialize(writer, dto, dto.GetType(), options);
    }

    // Wire DTOs: nullable everywhere so a missing field is a clear error from ToCommand, not a converter crash.
    private class BaseDto
    {
        [JsonPropertyOrder(-4)] public string? Op { get; set; }
        [JsonPropertyOrder(-3)] public string? Id { get; set; }
        [JsonPropertyOrder(-2)] public string? SheetId { get; set; }
        [JsonPropertyOrder(-1)] public string? StrokeId { get; set; }

        protected (string id, string sheet) Ids()
        {
            if (string.IsNullOrEmpty(Id)) throw new JsonException($"{Op}: missing id");
            if (string.IsNullOrEmpty(SheetId)) throw new JsonException($"{Op} {Id}: missing sheetId");
            return (Id, SheetId);
        }

        protected static T Need<T>(T? v, string what, string? id) where T : class => v ?? throw new JsonException($"{id}: missing {what}");
        protected static double Need(double? v, string what, string? id) => v is { } d && double.IsFinite(d) ? d : throw new JsonException($"{id}: missing or non-finite {what}");
    }

    private sealed class PointDto
    {
        public double? X { get; set; }
        public double? Y { get; set; }
        public static PointDto Of(SheetPoint p) => new() { X = p.X, Y = p.Y };
        public SheetPoint To(string? id) => new(
            X is { } x && double.IsFinite(x) ? x : throw new JsonException($"{id}: bad point"),
            Y is { } y && double.IsFinite(y) ? y : throw new JsonException($"{id}: bad point"));
    }

    private sealed class RectDto
    {
        public double? X { get; set; }
        public double? Y { get; set; }
        public double? W { get; set; }
        public double? H { get; set; }
        public static RectDto Of(SheetRect r) => new() { X = r.X, Y = r.Y, W = r.W, H = r.H };
        public SheetRect To(string? id) => X is { } x && Y is { } y && W is { } w && H is { } h && double.IsFinite(x + y + w + h)
            ? new SheetRect(x, y, w, h)
            : throw new JsonException($"{id}: bad bbox");
    }

    private sealed class PathDto
    {
        public List<PointDto>? Points { get; set; }
        public bool Closed { get; set; }
    }

    private sealed class CreateWallDto : BaseDto
    {
        public PathDto? Path { get; set; }
        public string? WallType { get; set; }
        public string? HostRef { get; set; }

        public CreateWall ToCommand()
        {
            var (id, sheet) = Ids();
            var path = Need(Path, "path", id);
            var pts = Need(path.Points, "path.points", id).Select(p => p.To(id)).ToList();
            return new CreateWall { Id = id, SheetId = sheet, StrokeId = StrokeId, Path = new SheetPath(pts, path.Closed), WallType = WallType, HostRef = HostRef };
        }
    }

    private sealed class PlaceDoorDto : BaseDto
    {
        public PointDto? At { get; set; }
        public double? WidthPt { get; set; }
        public double? AngleRad { get; set; }
        public string? HostWallRef { get; set; }
        public string? FamilyType { get; set; }

        public PlaceDoor ToCommand()
        {
            var (id, sheet) = Ids();
            return new PlaceDoor
            {
                Id = id, SheetId = sheet, StrokeId = StrokeId,
                At = Need(At, "at", id).To(id), WidthPt = Need(WidthPt, "widthPt", id), AngleRad = Need(AngleRad, "angleRad", id),
                HostWallRef = HostWallRef, FamilyType = FamilyType,
            };
        }
    }

    private sealed class PlaceInstanceDto : BaseDto
    {
        public PointDto? At { get; set; }
        public RectDto? Bbox { get; set; }
        public double? AngleRad { get; set; }
        public string? Family { get; set; }

        public PlaceInstance ToCommand()
        {
            var (id, sheet) = Ids();
            return new PlaceInstance
            {
                Id = id, SheetId = sheet, StrokeId = StrokeId,
                At = Need(At, "at", id).To(id), Bbox = Need(Bbox, "bbox", id).To(id), AngleRad = Need(AngleRad, "angleRad", id), Family = Family,
            };
        }
    }

    private sealed class DeleteDto : BaseDto
    {
        public List<string>? Targets { get; set; }

        public DeleteElements ToCommand()
        {
            var (id, sheet) = Ids();
            return new DeleteElements { Id = id, SheetId = sheet, StrokeId = StrokeId, Targets = Need(Targets, "targets", id) };
        }
    }

    private sealed class SetTypeDto : BaseDto
    {
        public List<string>? Targets { get; set; }
        public string? TypeName { get; set; }
        public string? Family { get; set; }

        public SetType ToCommand()
        {
            var (id, sheet) = Ids();
            var name = TypeName is { Length: > 0 } n ? n : throw new JsonException($"{id}: missing typeName");
            return new SetType { Id = id, SheetId = sheet, StrokeId = StrokeId, Targets = Need(Targets, "targets", id), TypeName = name, Family = string.IsNullOrEmpty(Family) ? null : Family };
        }
    }
}
