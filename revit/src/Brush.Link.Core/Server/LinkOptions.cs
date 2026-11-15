using System.Text.Json;
using System.Text.Json.Nodes;
using Brush.Link.Model;

namespace Brush.Link.Server;

/// <summary>
/// Link settings. The Revit add-in reads them from <c>%APPDATA%\Brush\revit-link.json</c>; any key may be left out.
/// </summary>
public sealed record LinkOptions
{
    public const int DefaultPort = 47821;

    /// <summary>Loopback port. 0 picks a free one (tests).</summary>
    public int Port { get; init; } = DefaultPort;

    /// <summary>
    /// Origins (scheme://host[:port], exact match) that may connect without asking. Any other web page triggers an
    /// "Allow this page to edit the model?" prompt in the host.
    /// </summary>
    public IReadOnlyList<string> AllowedOrigins { get; init; } =
    [
        "http://localhost:5173", "http://127.0.0.1:5173", // editor `pnpm dev`
        "http://localhost:4173", "http://127.0.0.1:4173", // `vite preview`
    ];

    /// <summary>
    /// Allow clients that send no Origin header. Browsers always send one on a WebSocket handshake, so this only lets
    /// in local programs (scripts, tests), which could reach the model through the machine anyway.
    /// </summary>
    public bool AllowMissingOrigin { get; init; } = true;

    /// <summary>Largest message the editor may send.</summary>
    public int MaxMessageBytes { get; init; } = 16 * 1024 * 1024;

    /// <summary>Wait this long after the last model change before re-exporting open sheets.</summary>
    public int ModelChangeDebounceMs { get; init; } = 600;

    /// <summary>
    /// After an apply or revert only the edited sheet is re-exported at once. The other open sheets (which may show the
    /// same elements) are refreshed this long after the last edit, so a run of sketched walls does not wait behind
    /// exports of sheets the user is not looking at.
    /// </summary>
    public int OtherSheetsAfterEditMs { get; init; } = 3000;

    public static LinkOptions Load(string path)
    {
        if (!File.Exists(path)) return new LinkOptions();
        return JsonSerializer.Deserialize<LinkOptions>(File.ReadAllText(path), Json.Options) ?? new LinkOptions();
    }

    /// <summary>Remember an origin the user chose to always allow.</summary>
    public static void AddAllowedOrigin(string path, string origin)
    {
        var node = File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? new JsonObject() : new JsonObject();
        if (node["allowedOrigins"] is not JsonArray list)
        {
            list = new JsonArray(new LinkOptions().AllowedOrigins.Select(o => (JsonNode?)JsonValue.Create(o)).ToArray());
            node["allowedOrigins"] = list;
        }
        if (!list.Any(n => n?.GetValue<string>() == origin)) list.Add(JsonValue.Create(origin));
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path))!);
        File.WriteAllText(path, node.ToJsonString(new JsonSerializerOptions(Json.Options) { WriteIndented = true }));
    }
}

public interface ILinkLog
{
    void Info(string message);
    void Error(string message, Exception? e = null);
}

public sealed class ConsoleLinkLog : ILinkLog
{
    public void Info(string message) => Console.WriteLine($"[link] {message}");
    public void Error(string message, Exception? e = null) => Console.Error.WriteLine($"[link] {message}{(e is null ? "" : $": {e}")}");
}

public sealed class NullLinkLog : ILinkLog
{
    public static readonly NullLinkLog Instance = new();
    public void Info(string message) { }
    public void Error(string message, Exception? e = null) { }
}
