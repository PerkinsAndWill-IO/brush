namespace Brush.Link.Server;

/// <summary>
/// Who may open the link. The server only listens on loopback, but any web page the user visits can try to open
/// <c>ws://localhost</c>, so the Origin header decides: configured origins pass, others ask the user once per session.
/// </summary>
public sealed class OriginPolicy(LinkOptions options, Func<string, CancellationToken, Task<bool>> askUser)
{
    private readonly HashSet<string> allowed = new(options.AllowedOrigins.Select(Normalize), StringComparer.Ordinal);
    private readonly Dictionary<string, bool> decided = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim prompt = new(1, 1);

    public async Task<bool> IsAllowedAsync(string? origin, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(origin)) return options.AllowMissingOrigin;
        var o = Normalize(origin);
        // "null" is the origin of sandboxed iframes and file:// pages: never trust it.
        if (o == "null" || !Uri.TryCreate(o, UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https")) return false;
        if (allowed.Contains(o)) return true;
        // One prompt at a time, and one answer per origin per session, so a page cannot spam dialogs.
        await prompt.WaitAsync(ct);
        try
        {
            if (decided.TryGetValue(o, out var d)) return d;
            var ok = await askUser(o, ct);
            decided[o] = ok;
            return ok;
        }
        finally
        {
            prompt.Release();
        }
    }

    public static string Normalize(string origin) => origin.Trim().TrimEnd('/').ToLowerInvariant();
}
