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
