using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Brush.Link.Host;
using Brush.Link.Model;
using Brush.Link.Server;
using Xunit;

namespace Brush.Link.Tests;

/// <summary>End to end over a real socket: the editor's side of the conversation, against the package host.</summary>
public sealed class LinkServerTests : IAsyncLifetime
{
    private const string EditorOrigin = "http://localhost:5173";
    private PackageHost host = null!;
    private LinkServer server = null!;

    public Task InitializeAsync()
    {
        host = PackageHost.FromFile(Path.Combine(AppContext.BaseDirectory, "fixtures", "office-1-sheet.drawing"));
        host.ApproveOrigin = o => o == "https://approved.example";
        server = new LinkServer(host, new LinkOptions { Port = 0, ModelChangeDebounceMs = 60_000 });
        server.Start();
        return Task.CompletedTask;
    }

    public async Task DisposeAsync() => await server.DisposeAsync();

    private sealed class Client(ClientWebSocket ws) : IAsyncDisposable
    {
        public async Task SendAsync(JsonObject msg) =>
            await ws.SendAsync(Encoding.UTF8.GetBytes(msg.ToJsonString()), WebSocketMessageType.Text, true, Timeout());

        public async Task<JsonObject> ReceiveAsync()
        {
            var buf = new byte[1 << 16];
            using var ms = new MemoryStream();
            while (true)
            {
                var r = await ws.ReceiveAsync(buf, Timeout());
                if (r.MessageType == WebSocketMessageType.Close) throw new InvalidOperationException($"closed: {ws.CloseStatusDescription}");
                ms.Write(buf, 0, r.Count);
                if (r.EndOfMessage) return JsonNode.Parse(ms.ToArray())!.AsObject();
            }
        }

        public async Task<JsonObject> ExpectAsync(string type)
        {
            var m = await ReceiveAsync();
            Assert.True(m["type"]!.GetValue<string>() == type, $"expected {type}, got {m.ToJsonString()[..Math.Min(300, m.ToJsonString().Length)]}");
            return m;
        }

        private static CancellationToken Timeout() => new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token;

        public async ValueTask DisposeAsync()
        {
            if (ws.State == WebSocketState.Open) await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
            ws.Dispose();
        }
    }

    private async Task<Client> ConnectAsync(string? origin = EditorOrigin, bool hello = true)
    {
        var ws = new ClientWebSocket();
        if (origin is not null) ws.Options.SetRequestHeader("Origin", origin);
        await ws.ConnectAsync(server.Url, CancellationToken.None);
        var c = new Client(ws);
        if (hello)
        {
            await c.SendAsync(new JsonObject { ["type"] = "hello", ["protocol"] = 1, ["client"] = "test" });
            var w = await c.ExpectAsync("welcome");
            Assert.Equal("A-201", w["sheets"]![0]!["id"]!.GetValue<string>());
        }
        return c;
    }

    private static int ElementCount(JsonObject sheetMsg) => sheetMsg["package"]!["sheets"]![0]!["elements"]!.AsArray().Count;

    private static JsonObject Apply(string requestId, int baseVersion, params JsonObject[] commands) => new()
    {
        ["type"] = "apply", ["requestId"] = requestId, ["sheetId"] = "A-201", ["baseVersion"] = baseVersion,
        ["commands"] = new JsonArray(commands.Cast<JsonNode>().ToArray()),
    };

    private static JsonObject Wall(string id) => JsonNode.Parse($$"""
        {"op":"create_wall","id":"{{id}}","sheetId":"A-201","strokeId":"s","path":{"points":[{"x":300,"y":300},{"x":500,"y":300}],"closed":false},"wallType":"Generic - 200mm"}
        """)!.AsObject();

    [Fact]
    public async Task Open_apply_revert_round_trip_bumps_versions_and_returns_the_new_sheet()
    {
        await using var c = await ConnectAsync();
        await c.SendAsync(new JsonObject { ["type"] = "open_sheet", ["requestId"] = "r1", ["sheetId"] = "A-201" });
        var v1 = await c.ExpectAsync("sheet");
        Assert.Equal(1, v1["version"]!.GetValue<int>());
        Assert.Equal("open", v1["reason"]!.GetValue<string>());
        Assert.Equal("base64", v1["package"]!["pdf"]!["encoding"]!.GetValue<string>());
        var before = ElementCount(v1);

        await c.SendAsync(Apply("r2", 1, Wall("cmd-0001")));
        var applied = await c.ExpectAsync("applied");
        Assert.Equal("r2", applied["requestId"]!.GetValue<string>());
        Assert.False(applied["stale"]!.GetValue<bool>());
        Assert.Equal("applied", applied["results"]![0]!["status"]!.GetValue<string>());
        var newId = applied["results"]![0]!["elementIds"]![0]!.GetValue<string>();
        var v2 = await c.ExpectAsync("sheet");
        Assert.Equal(2, v2["version"]!.GetValue<int>());
        Assert.Equal("apply", v2["reason"]!.GetValue<string>());
        Assert.Equal(before + 1, ElementCount(v2));
        Assert.Contains(v2["package"]!["sheets"]![0]!["elements"]!.AsArray(), e => e!["id"]!.GetValue<string>() == newId);

        // Applying the same command again is a no-op: no new version.
        await c.SendAsync(Apply("r3", 1, Wall("cmd-0001")));
        var again = await c.ExpectAsync("applied");
        Assert.True(again["stale"]!.GetValue<bool>());
        Assert.Equal("skipped", again["results"]![0]!["status"]!.GetValue<string>());

        await c.SendAsync(new JsonObject { ["type"] = "revert", ["requestId"] = "r4", ["sheetId"] = "A-201", ["commandIds"] = new JsonArray("cmd-0001") });
        Assert.Equal("applied", (await c.ExpectAsync("reverted"))["results"]![0]!["status"]!.GetValue<string>());
        var v3 = await c.ExpectAsync("sheet");
        Assert.Equal(3, v3["version"]!.GetValue<int>());
        Assert.Equal(before, ElementCount(v3));
    }

    [Fact]
    public async Task A_failed_command_reports_why_and_does_not_block_the_rest()
    {
        await using var c = await ConnectAsync();
        var bad = JsonNode.Parse("""{"op":"delete","id":"cmd-0009","sheetId":"A-201","targets":["w4-5"],"strokeId":"s"}""")!.AsObject();
        await c.SendAsync(Apply("r", 0, bad, Wall("cmd-0010")));
        var applied = await c.ExpectAsync("applied");
        Assert.Equal("failed", applied["results"]![0]!["status"]!.GetValue<string>());
        Assert.Contains("w4-5", applied["results"]![0]!["message"]!.GetValue<string>());
        Assert.Equal("applied", applied["results"]![1]!["status"]!.GetValue<string>());
    }

    private static JsonObject SetType(string id, string target, string typeName, string? family = null)
    {
        var o = new JsonObject { ["op"] = "set_type", ["id"] = id, ["sheetId"] = "A-201", ["targets"] = new JsonArray(target), ["typeName"] = typeName, ["strokeId"] = $"type:{target}" };
        if (family is not null) o["family"] = family;
        return o;
    }

    private static string? TypeOf(JsonObject sheetMsg, string elementId) =>
        sheetMsg["package"]!["sheets"]![0]!["elements"]!.AsArray().First(e => e!["id"]!.GetValue<string>() == elementId)!["typeName"]?.GetValue<string>();

    [Fact]
    public async Task Set_type_changes_the_elements_type_and_revert_puts_the_old_one_back()
    {
        await using var c = await ConnectAsync();
        await c.SendAsync(new JsonObject { ["type"] = "open_sheet", ["sheetId"] = "A-201" });
        var v1 = await c.ExpectAsync("sheet");
        Assert.Equal("Single-Flush 0900x2100", TypeOf(v1, "101000"));
        Assert.Equal("Partition - 100mm", TypeOf(v1, "100005"));
        var before = ElementCount(v1);

        await c.SendAsync(Apply("t1", 1, SetType("cmd-0100", "101000", "Single-Flush 1400x2100"), SetType("cmd-0101", "wall-100005", "generic - 200MM")));
        var applied = await c.ExpectAsync("applied");
        var r = applied["results"]!.AsArray();
        Assert.Equal("applied", r[0]!["status"]!.GetValue<string>());
        Assert.Equal("101000", r[0]!["elementIds"]![0]!.GetValue<string>());
        Assert.Null(r[0]!["notes"]);
        Assert.Equal("applied", r[1]!["status"]!.GetValue<string>());
        Assert.Equal("100005", r[1]!["elementIds"]![0]!.GetValue<string>());
        var v2 = await c.ExpectAsync("sheet");
        Assert.Equal("apply", v2["reason"]!.GetValue<string>());
        Assert.Equal("Single-Flush 1400x2100", TypeOf(v2, "101000"));
        Assert.Equal("Generic - 200mm", TypeOf(v2, "100005"));
        Assert.Equal(before, ElementCount(v2)); // the same elements, nothing created or removed

        await c.SendAsync(new JsonObject { ["type"] = "revert", ["requestId"] = "t2", ["sheetId"] = "A-201", ["commandIds"] = new JsonArray("cmd-0100", "cmd-0101") });
        var reverted = (await c.ExpectAsync("reverted"))["results"]!.AsArray();
        Assert.All(reverted, x => Assert.Equal("applied", x!["status"]!.GetValue<string>()));
        Assert.Equal("101000", reverted[0]!["elementIds"]![0]!.GetValue<string>());
        var v3 = await c.ExpectAsync("sheet");
        Assert.Equal("revert", v3["reason"]!.GetValue<string>());
        Assert.Equal("Single-Flush 0900x2100", TypeOf(v3, "101000"));
        Assert.Equal("Partition - 100mm", TypeOf(v3, "100005"));
    }

    [Fact]
    public async Task Set_type_to_a_missing_type_fails_and_names_the_types_there_are()
    {
        await using var c = await ConnectAsync();
        await c.SendAsync(Apply("t", 0, SetType("cmd-0200", "100000", "Curtain Wall 1"), SetType("cmd-0201", "999999", "Generic - 200mm")));
        var r = (await c.ExpectAsync("applied"))["results"]!.AsArray();
        Assert.Equal("failed", r[0]!["status"]!.GetValue<string>());
        var why = r[0]!["message"]!.GetValue<string>();
        Assert.Contains("no Walls type 'Curtain Wall 1'", why);
        Assert.Contains("'Partition - 100mm'", why);
        Assert.Equal("failed", r[1]!["status"]!.GetValue<string>());
        Assert.Contains("no element 999999", r[1]!["message"]!.GetValue<string>());
    }

    [Fact]
    public async Task Set_type_uses_the_closest_match_with_a_note_and_a_later_change_is_not_undone_by_revert()
    {
        await using var c = await ConnectAsync();
        // The editor names Revit types "Family: Type"; the fixture's door types have no family, so the type name wins.
        await c.SendAsync(Apply("t1", 0, SetType("cmd-0300", "101001", "Single-Flush 1400x2100", family: "M_Single-Flush")));
        var r = (await c.ExpectAsync("applied"))["results"]![0]!;
        Assert.Equal("applied", r["status"]!.GetValue<string>());
        Assert.Equal("no Doors type 'M_Single-Flush: Single-Flush 1400x2100', used 'Single-Flush 1400x2100'", r["notes"]![0]!.GetValue<string>());

        // Someone changes the door's type again in the host; the editor's undo must not overwrite that.
        host.ExternalEdit("A-201", els =>
        {
            var i = els.FindIndex(e => e.Id == "101001");
            els[i] = els[i] with { TypeName = "Single-Flush 0900x2100" };
        });
        await c.SendAsync(new JsonObject { ["type"] = "revert", ["requestId"] = "t2", ["sheetId"] = "A-201", ["commandIds"] = new JsonArray("cmd-0300") });
        var rev = (await c.ExpectAsync("reverted"))["results"]![0]!;
        Assert.Equal("skipped", rev["status"]!.GetValue<string>());
        Assert.Contains("left as it is", rev["message"]!.GetValue<string>());
    }

    [Fact]
    public async Task Edits_made_in_the_host_reach_every_editor_with_the_sheet_open()
    {
        await using var a = await ConnectAsync();
        await using var b = await ConnectAsync();
        foreach (var c in new[] { a, b })
        {
            await c.SendAsync(new JsonObject { ["type"] = "open_sheet", ["sheetId"] = "A-201" });
            await c.ExpectAsync("sheet");
        }
        host.ExternalEdit("A-201", els => els.RemoveAt(0));
        await server.Hub.FlushModelChangesAsync();
        foreach (var c in new[] { a, b })
        {
            var m = await c.ExpectAsync("sheet");
            Assert.Equal("model_changed", m["reason"]!.GetValue<string>());
            Assert.Equal(2, m["version"]!.GetValue<int>());
        }
    }

    [Fact]
    public async Task Messages_before_hello_and_unknown_sheets_get_errors_not_disconnects()
    {
        await using var c = await ConnectAsync(hello: false);
        await c.SendAsync(new JsonObject { ["type"] = "ping", ["requestId"] = "p" });
        Assert.Equal("hello_required", (await c.ExpectAsync("error"))["code"]!.GetValue<string>());
        await c.SendAsync(new JsonObject { ["type"] = "hello", ["protocol"] = 1 });
        await c.ExpectAsync("welcome");
        await c.SendAsync(new JsonObject { ["type"] = "open_sheet", ["requestId"] = "o", ["sheetId"] = "nope" });
        var err = await c.ExpectAsync("error");
        Assert.Equal("unknown_sheet", err["code"]!.GetValue<string>());
        Assert.Equal("o", err["requestId"]!.GetValue<string>());
        await c.SendAsync(new JsonObject { ["type"] = "ping", ["requestId"] = "p2" });
        Assert.Equal("p2", (await c.ExpectAsync("pong"))["requestId"]!.GetValue<string>());
    }

    [Fact]
    public async Task Show_sheet_activates_the_sheet_in_the_host_and_is_answered()
    {
        await using var c = await ConnectAsync();
        await c.SendAsync(new JsonObject { ["type"] = "show_sheet", ["requestId"] = "s", ["sheetId"] = "A-201" });
        var shown = await c.ExpectAsync("shown");
        Assert.Equal("s", shown["requestId"]!.GetValue<string>());
        Assert.Equal("A-201", shown["sheetId"]!.GetValue<string>());
        Assert.Equal("A-201", host.ShownSheet);
        await c.SendAsync(new JsonObject { ["type"] = "show_sheet", ["requestId"] = "x", ["sheetId"] = "nope" });
        Assert.Equal("unknown_sheet", (await c.ExpectAsync("error"))["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task Protocol_mismatch_is_refused()
    {
        await using var c = await ConnectAsync(hello: false);
        await c.SendAsync(new JsonObject { ["type"] = "hello", ["protocol"] = 99 });
        Assert.Equal("protocol_mismatch", (await c.ExpectAsync("error"))["code"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("https://evil.example", false)]
    [InlineData("null", false)]
    [InlineData("https://approved.example", true)]
    [InlineData(EditorOrigin, true)]
    [InlineData(null, true)]
    public async Task Only_allowed_or_approved_origins_connect(string? origin, bool ok)
    {
        var ws = new ClientWebSocket();
        if (origin is not null) ws.Options.SetRequestHeader("Origin", origin);
        if (ok)
        {
            await ws.ConnectAsync(server.Url, CancellationToken.None);
            Assert.Equal(WebSocketState.Open, ws.State);
        }
        else
        {
            await Assert.ThrowsAsync<WebSocketException>(() => ws.ConnectAsync(server.Url, CancellationToken.None));
        }
        ws.Dispose();
    }

    [Fact]
    public async Task A_foreign_host_header_is_refused_dns_rebinding()
    {
        using var tcp = new TcpClient();
        await tcp.ConnectAsync("127.0.0.1", server.Port);
        var s = tcp.GetStream();
        var req = $"GET /link HTTP/1.1\r\nHost: evil.example:{server.Port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: {EditorOrigin}\r\n\r\n";
        await s.WriteAsync(Encoding.ASCII.GetBytes(req));
        var buf = new byte[256];
        var n = await s.ReadAsync(buf);
        Assert.StartsWith("HTTP/1.1 403", Encoding.ASCII.GetString(buf, 0, n));
    }

    [Fact]
    public async Task Health_answers_plain_http()
    {
        using var http = new HttpClient();
        var body = await http.GetStringAsync($"http://127.0.0.1:{server.Port}/health");
        Assert.Equal("DevHost", JsonNode.Parse(body)!["host"]!.GetValue<string>());
    }
}

public class OriginPolicyTests
{
    [Fact]
    public async Task Asks_once_per_origin_and_remembers_the_answer()
    {
        var asked = 0;
        var policy = new OriginPolicy(new LinkOptions(), (_, _) => { asked++; return Task.FromResult(false); });
        Assert.True(await policy.IsAllowedAsync("http://localhost:5173/", default));
        Assert.False(await policy.IsAllowedAsync("https://x.example", default));
        Assert.False(await policy.IsAllowedAsync("https://X.example", default));
        Assert.Equal(1, asked);
        Assert.False(await policy.IsAllowedAsync("file://", default));
        Assert.Equal(1, asked);
    }

    [Fact]
    public void Always_allow_is_written_to_the_settings_file()
    {
        var path = Path.Combine(Path.GetTempPath(), $"brush-link-{Guid.NewGuid():N}", "revit-link.json");
        LinkOptions.AddAllowedOrigin(path, "https://brush.example");
        LinkOptions.AddAllowedOrigin(path, "https://brush.example");
        var o = LinkOptions.Load(path);
        Assert.Contains("https://brush.example", o.AllowedOrigins);
        Assert.Contains("http://localhost:5173", o.AllowedOrigins);
        Assert.Single(o.AllowedOrigins, x => x == "https://brush.example");
        Directory.Delete(Path.GetDirectoryName(path)!, true);
    }
}

/// <summary>
/// An apply re-exports only the sheet it edited. Other open sheets are refreshed afterwards in the background, so the
/// next edit does not wait behind exports of sheets nobody is drawing on (a large sheet's PDF can take a minute).
/// </summary>
public sealed class EditRefreshTests
{
    /// <summary>Counts exports per sheet, and can hold one sheet's export until released.</summary>
    private sealed class CountingHost(ILinkHost inner) : ILinkHost
    {
        public readonly Dictionary<string, int> Exports = new(StringComparer.Ordinal);
        public string? HoldSheet;
        public TaskCompletionSource HoldStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public string Name => inner.Name;
        public event Action<IReadOnlyCollection<string>?>? ModelChanged { add => inner.ModelChanged += value; remove => inner.ModelChanged -= value; }
        public Task<DocumentInfo> GetDocumentAsync(CancellationToken ct) => inner.GetDocumentAsync(ct);
        public async Task<SheetExport> ExportSheetAsync(string sheetId, CancellationToken ct)
        {
            lock (Exports) Exports[sheetId] = Exports.GetValueOrDefault(sheetId) + 1;
            if (sheetId == HoldSheet)
            {
                HoldStarted.TrySetResult();
                await Release.Task.WaitAsync(ct);
            }
            return await inner.ExportSheetAsync(sheetId, ct);
        }
        public int ExportsOf(string id) { lock (Exports) return Exports.GetValueOrDefault(id); }
        public Task<IReadOnlyList<CommandResult>> ApplyAsync(string sheetId, IReadOnlyList<Command> commands, CancellationToken ct) => inner.ApplyAsync(sheetId, commands, ct);
        public Task<IReadOnlyList<CommandResult>> RevertAsync(IReadOnlyList<string> commandIds, CancellationToken ct) => inner.RevertAsync(commandIds, ct);
        public Task ShowSheetAsync(string sheetId, CancellationToken ct) => inner.ShowSheetAsync(sheetId, ct);
        public Task<bool> ApproveOriginAsync(string origin, CancellationToken ct) => inner.ApproveOriginAsync(origin, ct);
        public Task<TypeList> ListTypesAsync(string elementId, CancellationToken ct) => inner.ListTypesAsync(elementId, ct);
    }

    private static (CountingHost counting, PackageHost inner) TwoSheetHost()
    {
        var (m, name, pdf) = DrawingPackage.Parse(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "fixtures", "office-1-sheet.drawing")));
        var second = m.Sheets[0] with { Id = "A-202", Number = "A-202", Elements = [] };
        var inner = new PackageHost(m with { Sheets = [m.Sheets[0], second] }, name, pdf);
        return (new CountingHost(inner), inner);
    }

    private static CancellationToken Soon() => new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token;

    private static async Task<ClientWebSocket> Open(LinkServer server, params string[] sheetIds)
    {
        var ws = new ClientWebSocket();
        await ws.ConnectAsync(server.Url, Soon());
        await Send(ws, new JsonObject { ["type"] = "hello", ["protocol"] = 1 });
        await Expect(ws, "welcome");
        foreach (var id in sheetIds)
        {
            await Send(ws, new JsonObject { ["type"] = "open_sheet", ["sheetId"] = id });
            await Expect(ws, "sheet");
        }
        return ws;
    }

    private static Task Send(ClientWebSocket ws, JsonObject m) => ws.SendAsync(Encoding.UTF8.GetBytes(m.ToJsonString()), WebSocketMessageType.Text, true, Soon());

    private static async Task<JsonObject> Expect(ClientWebSocket ws, string type)
    {
        var buf = new byte[1 << 16];
        using var ms = new MemoryStream();
        while (true)
        {
            var r = await ws.ReceiveAsync(buf, Soon());
            ms.Write(buf, 0, r.Count);
            if (!r.EndOfMessage) continue;
            var m = JsonNode.Parse(ms.ToArray())!.AsObject();
            Assert.True(m["type"]!.GetValue<string>() == type, $"expected {type}, got {m["type"]}");
            return m;
        }
    }

    private static JsonObject Wall(string id, int y = 300) => JsonNode.Parse($$"""
        {"type":"apply","sheetId":"A-201","commands":[{"op":"create_wall","id":"{{id}}","sheetId":"A-201","strokeId":"s","path":{"points":[{"x":300,"y":{{y}}},{"x":500,"y":{{y}}}],"closed":false},"wallType":"Generic - 200mm"}]}
        """)!.AsObject();

    [Fact]
    public async Task An_apply_exports_only_the_edited_sheet_and_leaves_the_others_to_the_background_refresh()
    {
        var (host, _) = TwoSheetHost();
        await using var server = new LinkServer(host, new LinkOptions { Port = 0, ModelChangeDebounceMs = 60_000, OtherSheetsAfterEditMs = 60_000 });
        server.Start();
        using var ws = await Open(server, "A-201", "A-202");
        Assert.Equal(1, host.ExportsOf("A-202"));

        await Send(ws, Wall("cmd-1"));
        await Expect(ws, "applied");
        Assert.Equal(2, (await Expect(ws, "sheet"))["version"]!.GetValue<int>());
        Assert.Equal(2, host.ExportsOf("A-201"));
        Assert.Equal(1, host.ExportsOf("A-202")); // not exported with the edit

        await server.Hub.FlushModelChangesAsync();
        Assert.Equal(2, host.ExportsOf("A-202")); // the background refresh does it
        Assert.Equal(2, host.ExportsOf("A-201")); // and leaves the edited sheet alone
    }

    [Fact]
    public async Task An_edit_during_the_background_refresh_goes_before_the_sheets_still_to_do()
    {
        var (host, inner) = TwoSheetHost();
        await using var server = new LinkServer(host, new LinkOptions { Port = 0, ModelChangeDebounceMs = 60_000, OtherSheetsAfterEditMs = 60_000 });
        server.Start();
        using var ws = await Open(server, "A-202", "A-201");

        // edits made in Revit on both open sheets: hold the first sheet's export while an apply comes in
        host.HoldSheet = "A-202";
        inner.ExternalEdit("A-202", _ => { });
        inner.ExternalEdit("A-201", _ => { });
        var flush = server.Hub.FlushModelChangesAsync();
        await host.HoldStarted.Task.WaitAsync(Soon());

        await Send(ws, Wall("cmd-2", 340));
        await Task.Delay(100);
        host.Release.TrySetResult();
        await Expect(ws, "applied");
        await Expect(ws, "sheet");
        await flush;
        // A-201 was exported for the apply, and the background refresh, which had it still to do, put it back in the
        // queue instead of exporting it before the apply
        Assert.Equal(2, host.ExportsOf("A-201"));
    }

    [Fact]
    public async Task A_type_list_request_during_the_background_refresh_goes_before_the_sheets_still_to_do()
    {
        // The type menu asks Revit for the types first; the editor's next message (the set_type apply) is only read
        // after it is answered. Waiting behind a whole refresh, the type change took 22 s on Snowdon Towers.
        var (host, inner) = TwoSheetHost();
        await using var server = new LinkServer(host, new LinkOptions { Port = 0, ModelChangeDebounceMs = 60_000, OtherSheetsAfterEditMs = 60_000 });
        server.Start();
        using var ws = await Open(server, "A-202", "A-201");

        host.HoldSheet = "A-202";
        inner.ExternalEdit("A-202", _ => { });
        inner.ExternalEdit("A-201", _ => { });
        var flush = server.Hub.FlushModelChangesAsync();
        await host.HoldStarted.Task.WaitAsync(Soon());

        // the menu opened twice: two requests in a row. Each one that is not counted as waiting lets one more sheet of
        // the refresh go before it.
        await Send(ws, new JsonObject { ["type"] = "list_types", ["requestId"] = "t1", ["elementId"] = "no-such-element" });
        await Send(ws, new JsonObject { ["type"] = "list_types", ["requestId"] = "t2", ["elementId"] = "no-such-element" });
        await Task.Delay(100);
        host.Release.TrySetResult();
        await Expect(ws, "error"); // answered (this element is unknown)
        await Expect(ws, "error");
        Assert.Equal(1, host.ExportsOf("A-201")); // both before A-201's refresh
        await flush;
    }
}


/// <summary>
/// Revit starts and stops the link on its UI thread, and blocks that thread until the link has stopped. Work posted to
/// the UI thread cannot run meanwhile, so neither the server's loops nor DisposeAsync may depend on it ("Reload the
/// plugin" froze Revit when they did).
/// </summary>
public sealed class ServerStopTests
{
    /// <summary>A UI thread: runs posted work one item at a time, until it blocks on something.</summary>
    private sealed class UiThread : SynchronizationContext, IDisposable
    {
        private readonly System.Collections.Concurrent.BlockingCollection<Action> work = new();
        private readonly Thread thread;

        public UiThread()
        {
            thread = new Thread(() =>
            {
                SetSynchronizationContext(this);
                foreach (var a in work.GetConsumingEnumerable()) a();
            }) { IsBackground = true };
            thread.Start();
        }

        public override void Post(SendOrPostCallback d, object? state) => work.Add(() => d(state));

        public Task Run(Action a)
        {
            var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            work.Add(() =>
            {
                try { a(); done.SetResult(); }
                catch (Exception e) { done.SetException(e); }
            });
            return done.Task;
        }

        public void Dispose() => work.CompleteAdding();
    }

    [Fact]
    public async Task Starting_and_then_blocking_on_dispose_from_the_ui_thread_with_an_editor_connected_does_not_deadlock()
    {
        using var ui = new UiThread();
        var host = PackageHost.FromFile(Path.Combine(AppContext.BaseDirectory, "fixtures", "office-1-sheet.drawing"));
        var server = new LinkServer(host, new LinkOptions { Port = 0 });
        await ui.Run(server.Start);
        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Origin", "http://localhost:5173");
        await ws.ConnectAsync(server.Url, new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);

        // what the plugin's StopLink did: block the UI thread on DisposeAsync
        var stopped = ui.Run(() => server.DisposeAsync().AsTask().GetAwaiter().GetResult());
        var finished = await Task.WhenAny(stopped, Task.Delay(TimeSpan.FromSeconds(5)));
        Assert.True(finished == stopped, "stopping the server waited for the blocked UI thread");
    }
}
