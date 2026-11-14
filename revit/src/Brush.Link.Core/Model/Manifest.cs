using System.Text.Json;
using System.Text.Json.Serialization;

namespace Brush.Link.Model;

/// <summary>
/// The editor's <c>.drawing</c> package manifest (editor decision 0002, <c>editor/src/core/context/package-format.ts</c>).
/// Coordinates are sheet points, origin top-left, y down.
/// </summary>
public sealed record DrawingManifest
{
    public const int Version = 1;
    public int SchemaVersion { get; init; } = Version;
    public string? Project { get; init; }
    public TypePalette? Palette { get; init; }
    public required IReadOnlyList<ManifestSheet> Sheets { get; init; }
}

public sealed record ManifestSheet
{
    /// <summary>Stable sheet id: the Revit sheet's ElementId as a string. Commands carry it back as <c>sheetId</c>.</summary>
    public required string Id { get; init; }
    public string? Number { get; init; }
    public required string Name { get; init; }
    public required SheetSize SizePt { get; init; }
    /// <summary>Scale denominator of the main viewport (100 for 1:100).</summary>
    public double? Scale { get; init; }
    public required IReadOnlyList<ManifestElement> Elements { get; init; }
}

public readonly record struct SheetSize(double W, double H);

public sealed record ManifestElement
{
    /// <summary>Host element id (Revit ElementId as a string). The editor's <c>hostRef</c>.</summary>
    public required string Id { get; init; }
    /// <summary>Walls, Doors, Windows, Grids, Rooms, Furniture, Casework, Text, or any other Revit category name.</summary>
    public required string Category { get; init; }
    public required IReadOnlyList<SheetPoint> Footprint { get; init; }
    public bool? Closed { get; init; }
    public string? TypeName { get; init; }
    public string? Label { get; init; }
    public IReadOnlyDictionary<string, string>? Props { get; init; }
}

public sealed record TypePalette
{
    public IReadOnlyList<WallTypeDef>? Walls { get; init; }
    public IReadOnlyList<DoorFamilyDef>? Doors { get; init; }
    public IReadOnlyList<FurnitureFamilyDef>? Furniture { get; init; }
}

public sealed record WallTypeDef(string Name, double ThicknessMm);

public sealed record DoorFamilyDef(string Name, double WidthMm, double? HeightMm = null);

public sealed record FurnitureFamilyDef(string Name, double WidthMm, double DepthMm);

/// <summary>
/// The JSON envelope container of editor decision 0005: the manifest at the top level plus
/// <c>"pdf": { "name", "encoding": "base64", "data" }</c>. This is what the editor's <c>parsePackage</c> reads.
/// </summary>
public static class DrawingPackage
{
    public static byte[] Serialize(DrawingManifest manifest, string? pdfName, byte[]? pdfBytes)
    {
        var node = JsonSerializer.SerializeToNode(manifest, Json.Options)!.AsObject();
        if (pdfBytes is not null)
        {
            node["pdf"] = new System.Text.Json.Nodes.JsonObject
            {
                ["name"] = pdfName ?? "sheet.pdf",
                ["encoding"] = "base64",
                ["data"] = Convert.ToBase64String(pdfBytes),
            };
        }
        return JsonSerializer.SerializeToUtf8Bytes(node, Json.Options);
    }

    /// <summary>Read an envelope back (used by the dev host to start from an editor fixture, and by tests).</summary>
    public static (DrawingManifest manifest, string? pdfName, byte[]? pdf) Parse(ReadOnlySpan<byte> utf8)
    {
        using var doc = JsonDocument.Parse(utf8.ToArray());
        var manifest = doc.RootElement.Deserialize<DrawingManifest>(Json.Options) ?? throw new JsonException("empty manifest");
        if (manifest.SchemaVersion != DrawingManifest.Version) throw new JsonException($"unsupported manifest schemaVersion {manifest.SchemaVersion}");
        if (!doc.RootElement.TryGetProperty("pdf", out var pdf) || pdf.ValueKind != JsonValueKind.Object) return (manifest, null, null);
        var name = pdf.TryGetProperty("name", out var n) ? n.GetString() : null;
        var data = pdf.TryGetProperty("data", out var d) && d.GetString() is { } s ? Convert.FromBase64String(s) : null;
        return (manifest, name, data);
    }
}

public static class Json
{
    /// <summary>camelCase, nulls omitted: the editor's JSON conventions.</summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = false,
        NumberHandling = JsonNumberHandling.Strict,
    };
}
