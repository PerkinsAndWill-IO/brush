using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Brush.Link.Host;
using Brush.Link.Model;
using Brush.Link.Planning;
using Brush.Link.Server;
using Xunit;

namespace Brush.Link.Tests;

/// <summary>S1-06: set_type, list_types and view pages, in the planner.</summary>
public class TypeSwitchPlannerTests
{
    private static readonly JsonSerializerOptions Opts = new(JsonSerializerDefaults.Web);

    [Fact]
    public void S1_06_set_type_parses_from_the_editor_json_and_plans_to_ChangeTypeOp()
    {
        const string json = """{"op":"set_type","id":"cmd-0001","sheetId":"A-201","targets":["wall-100000","unknown-100001","100002"],"family":null,"typeName":"Concrete - 400mm","typeId":"77","previousTypeName":"Generic - 200mm"}""";
        var cmd = Assert.IsType<SetType>(JsonSerializer.Deserialize<Command>(json, Opts));
        Assert.Equal("Concrete - 400mm", cmd.TypeName);
        var op = Assert.IsType<ChangeTypeOp>(CommandPlanner.Plan(cmd, null, _ => false));
        Assert.Equal(["100000", "100001", "100002"], op.HostIds);
        Assert.Equal("77", op.TypeId);
        var back = JsonNode.Parse(JsonSerializer.Serialize<Command>(cmd, Opts))!;
        Assert.Equal("set_type", back["op"]!.GetValue<string>());
        Assert.Equal("Concrete - 400mm", back["typeName"]!.GetValue<string>());
    }

    [Fact]
    public void S1_06_on_a_view_page_set_type_and_delete_plan_but_create_wall_is_rejected()
    {
        var wall = new CreateWall { Id = "w", SheetId = "v", Path = new SheetPath([new(0, 0), new(100, 0)], false) };
        var rejected = Assert.IsType<RejectedOp>(CommandPlanner.Plan(wall, null, _ => false));
        Assert.Contains("not on a sheet", rejected.Reason);
        Assert.IsType<DeleteOp>(CommandPlanner.Plan(new DeleteElements { Id = "d", SheetId = "v", Targets = ["100000"] }, null, _ => false));
        Assert.IsType<ChangeTypeOp>(CommandPlanner.Plan(new SetType { Id = "c", SheetId = "v", Targets = ["100000"], TypeName = "X" }, null, _ => false));
    }

    [Fact]
    public void S1_06_set_type_with_no_element_target_is_rejected()
    {
        var c = new SetType { Id = "c", SheetId = "s", Targets = ["w4-5"], TypeName = "X" };
        Assert.IsType<RejectedOp>(CommandPlanner.Plan(c, null, _ => false));
    }
}

/// <summary>S1-06 over a real socket, against the package host.</summary>
public sealed class TypeSwitchServerTests : IAsyncLifetime
{
    private PackageHost host = null!;
    private LinkServer server = null!;

    public Task InitializeAsync()
    {
        host = PackageHost.FromFile(Path.Combine(AppContext.BaseDirectory, "fixtures", "office-1-sheet.drawing"));
        host.AddView("900001", "{3D}", "ThreeD");
        server = new LinkServer(host, new LinkOptions { Port = 0, ModelChangeDebounceMs = 60_000 });
        server.Start();
        return Task.CompletedTask;
    }

    public async Task DisposeAsync() => await server.DisposeAsync();

    private async Task<(ClientWebSocket ws, JsonObject welcome)> ConnectAsync()
    {
        var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Origin", "http://localhost:5173");
        await ws.ConnectAsync(server.Url, CancellationToken.None);
        await SendAsync(ws, new JsonObject { ["type"] = "hello", ["protocol"] = 1 });
        return (ws, await ExpectAsync(ws, "welcome"));
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

    private static JsonObject Change(string id, string sheetId, string typeName) => new()
    {
        ["op"] = "set_type", ["id"] = id, ["sheetId"] = sheetId, ["targets"] = new JsonArray("100000"),
        ["family"] = null, ["typeName"] = typeName,
    };

    [Fact]
    public async Task S1_06_welcome_lists_views_and_list_types_answers_for_an_element()
    {
        var (ws, welcome) = await ConnectAsync();
        Assert.Equal("900001", welcome["views"]![0]!["id"]!.GetValue<string>());
        Assert.Equal("ThreeD", welcome["views"]![0]!["kind"]!.GetValue<string>());
        await SendAsync(ws, new JsonObject { ["type"] = "list_types", ["requestId"] = "t1", ["elementId"] = "100000" });
        var t = await ExpectAsync(ws, "types");
        Assert.Equal("t1", t["requestId"]!.GetValue<string>());
        Assert.Equal("Generic - 200mm", t["current"]!["typeName"]!.GetValue<string>());
        Assert.Contains(t["types"]!.AsArray(), x => x!["typeName"]!.GetValue<string>() == "Concrete - 400mm");
        await SendAsync(ws, new JsonObject { ["type"] = "list_types", ["requestId"] = "t2", ["elementId"] = "1" });
        var e = await ExpectAsync(ws, "error");
        Assert.Equal("unknown_element", e["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task S1_06_set_type_applies_and_revert_restores_the_previous_type_once()
    {
        var (ws, _) = await ConnectAsync();
        await SendAsync(ws, new JsonObject { ["type"] = "apply", ["requestId"] = "a1", ["sheetId"] = "A-201", ["commands"] = new JsonArray(Change("cmd-1", "A-201", "Concrete - 400mm")) });
        Assert.Equal("applied", (await ExpectAsync(ws, "applied"))["results"]![0]!["status"]!.GetValue<string>());
        await SendAsync(ws, new JsonObject { ["type"] = "list_types", ["requestId"] = "t", ["elementId"] = "100000" });
        Assert.Equal("Concrete - 400mm", (await ExpectAsync(ws, "types"))["current"]!["typeName"]!.GetValue<string>());

        await SendAsync(ws, new JsonObject { ["type"] = "revert", ["requestId"] = "r1", ["sheetId"] = "A-201", ["commandIds"] = new JsonArray("cmd-1") });
        Assert.Equal("applied", (await ExpectAsync(ws, "reverted"))["results"]![0]!["status"]!.GetValue<string>());
        await SendAsync(ws, new JsonObject { ["type"] = "list_types", ["requestId"] = "t", ["elementId"] = "100000" });
        Assert.Equal("Generic - 200mm", (await ExpectAsync(ws, "types"))["current"]!["typeName"]!.GetValue<string>());
        Assert.Equal(1, host.ElementCount("100000")); // reverting a type change never deletes the element

        await SendAsync(ws, new JsonObject { ["type"] = "revert", ["requestId"] = "r2", ["sheetId"] = "A-201", ["commandIds"] = new JsonArray("cmd-1") });
        Assert.Equal("skipped", (await ExpectAsync(ws, "reverted"))["results"]![0]!["status"]!.GetValue<string>());
    }

    [Fact]
    public async Task S1_06_apply_addressed_to_a_view_takes_set_type_and_rejects_a_wall()
    {
        var (ws, _) = await ConnectAsync();
        var wall = JsonNode.Parse("""{"op":"create_wall","id":"w1","sheetId":"900001","strokeId":"s","path":{"points":[{"x":0,"y":0},{"x":100,"y":0}],"closed":false}}""")!;
        await SendAsync(ws, new JsonObject { ["type"] = "apply", ["requestId"] = "a", ["sheetId"] = "900001", ["commands"] = new JsonArray(Change("cmd-v", "900001", "Concrete - 400mm"), wall) });
        var res = (await ExpectAsync(ws, "applied"))["results"]!.AsArray();
        Assert.Equal("applied", res[0]!["status"]!.GetValue<string>());
        Assert.Equal("failed", res[1]!["status"]!.GetValue<string>());
        Assert.Contains("not on a sheet", res[1]!["message"]!.GetValue<string>());
    }
}

public class CommandLedgerTests
{
    [Fact]
    public void S1_06_a_type_change_is_kept_in_the_shared_store_so_a_new_ledger_over_it_still_knows_it()
    {
        // RevitHost builds a new CommandLedger per call over one reload-proof dictionary
        var store = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        new CommandLedger(store).RecordTypeChange("cmd-1", [("42", "7"), ("43", "8")]);
        var later = new CommandLedger(store);
        Assert.True(later.Knows("cmd-1"));
        Assert.Empty(later.ElementsOf("cmd-1"));
        Assert.Equal([("42", "7"), ("43", "8")], later.TypeChangesOf("cmd-1"));
        later.Forget("cmd-1");
        Assert.False(new CommandLedger(store).Knows("cmd-1"));
        Assert.Empty(new CommandLedger(store).TypeChangesOf("cmd-1"));
    }
}

public sealed class TypeSwitchSkipTests : IAsyncLifetime
{
    private PackageHost host = null!;

    public Task InitializeAsync()
    {
        host = PackageHost.FromFile(Path.Combine(AppContext.BaseDirectory, "fixtures", "office-1-sheet.drawing"));
        return Task.CompletedTask;
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task S1_06_a_change_to_the_type_the_elements_already_have_is_skipped_not_failed()
    {
        var c = new SetType { Id = "cmd-same", SheetId = "A-201", Targets = ["100000"], TypeName = "Generic - 200mm" };
        var r = Assert.Single(await host.ApplyAsync("A-201", [c], CancellationToken.None));
        Assert.Equal(CommandStatus.Skipped, r.Status);
    }
}
