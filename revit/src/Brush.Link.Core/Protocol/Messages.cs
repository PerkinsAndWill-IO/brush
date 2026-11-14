using System.Text.Json;
using System.Text.Json.Nodes;
using Brush.Link.Host;
using Brush.Link.Model;

namespace Brush.Link.Protocol;

/// <summary>Wire protocol of the live link. Spec: <c>revit/docs/protocol.md</c>. Every message is one JSON text frame with a <c>type</c>.</summary>
public static class LinkProtocol
{
    public const int Version = 1;
    public const string Path = "/link";
}

// ─────────────── editor → plugin ───────────────

public abstract record ClientMessage
{
    public string? RequestId { get; init; }
}

public sealed record Hello(int Protocol, string? Client) : ClientMessage;

public sealed record ListSheets : ClientMessage;

public sealed record OpenSheet(string SheetId) : ClientMessage;

public sealed record CloseSheet(string SheetId) : ClientMessage;

/// <summary>Make the sheet the active view in the host, so the user sees in Revit the sheet they opened in the editor.</summary>
public sealed record ShowSheet(string SheetId) : ClientMessage;

public sealed record Apply(string SheetId, int? BaseVersion, IReadOnlyList<Command> Commands) : ClientMessage;

public sealed record Revert(string SheetId, IReadOnlyList<string> CommandIds) : ClientMessage;

public sealed record Ping : ClientMessage;

public sealed class ProtocolException(string code, string message, string? requestId = null) : Exception(message)
{
    public string Code { get; } = code;
    public string? RequestId { get; } = requestId;
}

public static class ErrorCodes
{
    public const string BadMessage = "bad_message";
    public const string UnknownType = "unknown_type";
    public const string ProtocolMismatch = "protocol_mismatch";
    public const string NotHello = "hello_required";
    public const string UnknownSheet = "unknown_sheet";
    public const string HostError = "host_error";
}

public static class ClientMessageParser
{
    public static ClientMessage Parse(string json)
    {
        JsonObject o;
        try
        {
            o = JsonNode.Parse(json) as JsonObject ?? throw new ProtocolException(ErrorCodes.BadMessage, "message is not a JSON object");
        }
        catch (JsonException e)
        {
            throw new ProtocolException(ErrorCodes.BadMessage, $"message is not JSON: {e.Message}");
        }
        var requestId = Str(o, "requestId");
        var type = Str(o, "type") ?? throw new ProtocolException(ErrorCodes.BadMessage, "message has no type", requestId);
        try
        {
            ClientMessage m = type switch
            {
                "hello" => new Hello(o["protocol"]?.GetValue<int>() ?? 0, Str(o, "client")),
                "list_sheets" => new ListSheets(),
                "open_sheet" => new OpenSheet(Need(o, "sheetId", requestId)),
                "close_sheet" => new CloseSheet(Need(o, "sheetId", requestId)),
                "show_sheet" => new ShowSheet(Need(o, "sheetId", requestId)),
                "apply" => new Apply(
                    Need(o, "sheetId", requestId),
                    o["baseVersion"]?.GetValue<int>(),
                    (o["commands"] as JsonArray ?? throw new ProtocolException(ErrorCodes.BadMessage, "apply needs commands", requestId))
                        .Deserialize<List<Command>>(Json.Options)!),
                "revert" => new Revert(
                    Need(o, "sheetId", requestId),
                    (o["commandIds"] as JsonArray ?? throw new ProtocolException(ErrorCodes.BadMessage, "revert needs commandIds", requestId))
                        .Select(n => n?.GetValue<string>() ?? throw new ProtocolException(ErrorCodes.BadMessage, "commandIds holds a null", requestId)).ToList()),
                "ping" => new Ping(),
                _ => throw new ProtocolException(ErrorCodes.UnknownType, $"unknown message type '{type}'", requestId),
            };
            return m with { RequestId = requestId };
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
        {
            throw new ProtocolException(ErrorCodes.BadMessage, $"{type}: {e.Message}", requestId);
        }
    }

    private static string? Str(JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static string Need(JsonObject o, string key, string? requestId) =>
        Str(o, key) is { Length: > 0 } s ? s : throw new ProtocolException(ErrorCodes.BadMessage, $"missing {key}", requestId);
}

// ─────────────── plugin → editor ───────────────

/// <summary>Builds the server's messages as JSON. Kept as plain objects so the shapes in protocol.md are easy to check.</summary>
public static class ServerMessages
{
    public static JsonObject Welcome(string serverName, string hostName, string epoch, DocumentInfo doc) => new()
    {
        ["type"] = "welcome",
        ["protocol"] = LinkProtocol.Version,
        ["server"] = new JsonObject { ["name"] = serverName, ["version"] = typeof(ServerMessages).Assembly.GetName().Version?.ToString(3), ["host"] = hostName, ["epoch"] = epoch },
        ["document"] = Document(doc),
        ["sheets"] = Sheets(doc.Sheets),
    };

    public static JsonObject SheetList(string? requestId, DocumentInfo doc) => WithRequest(new JsonObject
    {
        ["type"] = "sheets",
        ["document"] = Document(doc),
        ["sheets"] = Sheets(doc.Sheets),
    }, requestId);

    /// <summary>A new version of a sheet. <c>package</c> is the editor's .drawing JSON envelope (manifest + base64 PDF).</summary>
    public static JsonObject Sheet(string? requestId, string sheetId, int version, string reason, byte[] package) => WithRequest(new JsonObject
    {
        ["type"] = "sheet",
        ["sheetId"] = sheetId,
        ["version"] = version,
        ["reason"] = reason,
        ["package"] = JsonNode.Parse(package),
    }, requestId);

    public static JsonObject Applied(string? requestId, string sheetId, int? baseVersion, int currentVersion, IReadOnlyList<CommandResult> results) => WithRequest(new JsonObject
    {
        ["type"] = "applied",
        ["sheetId"] = sheetId,
        ["baseVersion"] = baseVersion,
        ["stale"] = baseVersion is { } b && b < currentVersion,
        ["results"] = JsonSerializer.SerializeToNode(results, Json.Options),
    }, requestId);

    public static JsonObject Reverted(string? requestId, string sheetId, IReadOnlyList<CommandResult> results) => WithRequest(new JsonObject
    {
        ["type"] = "reverted",
        ["sheetId"] = sheetId,
        ["results"] = JsonSerializer.SerializeToNode(results, Json.Options),
    }, requestId);

    public static JsonObject Shown(string? requestId, string sheetId) => WithRequest(new JsonObject
    {
        ["type"] = "shown",
        ["sheetId"] = sheetId,
    }, requestId);

    public static JsonObject Pong(string? requestId) => WithRequest(new JsonObject { ["type"] = "pong" }, requestId);

    public static JsonObject Error(string? requestId, string code, string message) => WithRequest(new JsonObject
    {
        ["type"] = "error",
        ["code"] = code,
        ["message"] = message,
    }, requestId);

    private static JsonObject Document(DocumentInfo d) => new() { ["title"] = d.Title, ["path"] = d.Path, ["project"] = d.Project };

    private static JsonArray Sheets(IReadOnlyList<SheetSummary> sheets) =>
        new(sheets.Select(s => (JsonNode)new JsonObject { ["id"] = s.Id, ["number"] = s.Number, ["name"] = s.Name }).ToArray());

    private static JsonObject WithRequest(JsonObject o, string? requestId)
    {
        if (requestId is not null) o["requestId"] = requestId;
        return o;
    }
}
