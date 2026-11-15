using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Brush.Link.Host;
using Brush.Link.Server;
using Xunit;

namespace Brush.Link.Tests;

/// <summary>S1-07: list_types over a real socket, against the package host.</summary>
public sealed class ListTypesTests : IAsyncLifetime
{
    private PackageHost host = null!;
    private LinkServer server = null!;

    public Task InitializeAsync()
    {
        host = PackageHost.FromFile(Path.Combine(AppContext.BaseDirectory, "fixtures", "office-1-sheet.drawing"));
        server = new LinkServer(host, new LinkOptions { Port = 0, ModelChangeDebounceMs = 60_000 });
        server.Start();
        return Task.CompletedTask;
    }

    public async Task DisposeAsync() => await server.DisposeAsync();

    private async Task<ClientWebSocket> ConnectAsync()
    {
        var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Origin", "http://localhost:5173");
        await ws.ConnectAsync(server.Url, CancellationToken.None);
        await SendAsync(ws, new JsonObject { ["type"] = "hello", ["protocol"] = 1 });
        await ExpectAsync(ws, "welcome");
        return ws;
    }

    private static Task SendAsync(ClientWebSocket ws, JsonObject m) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(m.ToJsonString()), WebSocketMessageType.Text, true, CancellationToken.None);

    private static async Task<JsonObject> ExpectAsync(ClientWebSocket ws, string type)
    {
        var ct = new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token;
        var buf = new byte[1 << 16];
        while (true)
        {
            using var ms = new MemoryStream();
            WebSocketReceiveResult r;
            do
            {
                r = await ws.ReceiveAsync(buf, ct);
                ms.Write(buf, 0, r.Count);
            } while (!r.EndOfMessage);
            var m = JsonNode.Parse(ms.ToArray())!.AsObject();
            if (m["type"]!.GetValue<string>() == type) return m;
        }
    }

    [Fact]
    public async Task S1_07_list_types_answers_the_types_an_element_can_take_and_its_current_one()
    {
        using var ws = await ConnectAsync();
        await SendAsync(ws, new JsonObject { ["type"] = "list_types", ["requestId"] = "t1", ["elementId"] = "100000" });
        var t = await ExpectAsync(ws, "types");
        Assert.Equal("t1", t["requestId"]!.GetValue<string>());
        Assert.Equal("100000", t["elementId"]!.GetValue<string>());
        Assert.Equal("Generic - 200mm", t["current"]!["typeName"]!.GetValue<string>());
        Assert.Contains(t["types"]!.AsArray(), x => x!["typeName"]!.GetValue<string>() == "Concrete - 400mm");
    }

    [Fact]
    public async Task S1_07_list_types_for_an_element_the_model_does_not_have_is_unknown_element()
    {
        using var ws = await ConnectAsync();
        await SendAsync(ws, new JsonObject { ["type"] = "list_types", ["requestId"] = "t2", ["elementId"] = "1" });
        var e = await ExpectAsync(ws, "error");
        Assert.Equal("t2", e["requestId"]!.GetValue<string>());
        Assert.Equal("unknown_element", e["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task S1_07_after_a_set_type_list_types_reports_the_new_current_type()
    {
        using var ws = await ConnectAsync();
        var change = new JsonObject
        {
            ["op"] = "set_type", ["id"] = "cmd-1", ["sheetId"] = "A-201", ["targets"] = new JsonArray("100000"),
            ["typeName"] = "Concrete - 400mm", ["strokeId"] = "type:100000",
        };
        await SendAsync(ws, new JsonObject { ["type"] = "apply", ["requestId"] = "a1", ["sheetId"] = "A-201", ["commands"] = new JsonArray(change) });
        Assert.Equal("applied", (await ExpectAsync(ws, "applied"))["results"]![0]!["status"]!.GetValue<string>());
        await SendAsync(ws, new JsonObject { ["type"] = "list_types", ["requestId"] = "t3", ["elementId"] = "100000" });
        Assert.Equal("Concrete - 400mm", (await ExpectAsync(ws, "types"))["current"]!["typeName"]!.GetValue<string>());
    }
}
