using Brush.Link.Host;
using Brush.Link.Server;

// Usage: dotnet run --project src/Brush.Link.DevHost -- [package.drawing] [--port N] [--allow-origin URL]...
// Default package: tests/fixtures/office-1-sheet.json.drawing (the editor's one-sheet fixture as a JSON envelope). Type "help" once it runs.
var args_ = args.ToList();
string? Take(string flag)
{
    var i = args_.IndexOf(flag);
    if (i < 0 || i + 1 >= args_.Count) return null;
    var v = args_[i + 1];
    args_.RemoveRange(i, 2);
    return v;
}

var port = int.TryParse(Take("--port"), out var p) ? p : LinkOptions.DefaultPort;
var extraOrigins = new List<string>();
while (Take("--allow-origin") is { } o) extraOrigins.Add(o);
var packagePath = args_.FirstOrDefault()
    ?? Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../tests/fixtures/office-1-sheet.json.drawing"));
if (!File.Exists(packagePath))
{
    Console.Error.WriteLine($"no package at {packagePath}; pass one: dotnet run --project src/Brush.Link.DevHost -- path/to/file.drawing");
    return 1;
}

var host = PackageHost.FromFile(packagePath);
var defaults = new LinkOptions();
var options = defaults with { Port = port, AllowedOrigins = [.. defaults.AllowedOrigins, .. extraOrigins] };
host.ApproveOrigin = origin =>
{
    Console.WriteLine($"[link] refused {origin}: start with --allow-origin {origin} to let it in");
    return false;
};

await using var server = new LinkServer(host, options, new ConsoleLinkLog());
server.Start();
Console.WriteLine($"DevHost serving {Path.GetFileName(packagePath)} at {server.Url}  (health: http://127.0.0.1:{server.Port}/health)");
Console.WriteLine("Type 'help' for commands, Ctrl+C or 'quit' to stop.");

var done = new TaskCompletionSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; done.TrySetResult(); };
_ = Task.Run(async () =>
{
    while (await Console.In.ReadLineAsync() is { } line)
    {
        var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) continue;
        try
        {
            switch (parts[0])
            {
                case "quit" or "exit":
                    done.TrySetResult();
                    return;
                case "sheets":
                    foreach (var s in (await host.GetDocumentAsync(default)).Sheets) Console.WriteLine($"  {s.Id}  {s.Number}  {s.Name}");
                    break;
                case "rm" when parts.Length == 3:
                    // Simulate an edit made in Revit: remove an element from a sheet; open editors get a new version.
                    host.ExternalEdit(parts[1], els => Console.WriteLine(els.RemoveAll(e => e.Id == parts[2]) > 0 ? "  removed" : "  no such element"));
                    break;
                default:
                    Console.WriteLine("  sheets              list sheets\n  rm <sheet> <elemId> remove an element as if edited in Revit (pushes a new version)\n  quit");
                    break;
            }
        }
        catch (Exception e)
        {
            Console.WriteLine($"  {e.Message}");
        }
    }
});
await done.Task;
return 0;
