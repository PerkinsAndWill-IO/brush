using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Brush.Link.Host;
using Brush.Link.Model;
using Brush.Link.Protocol;

namespace Brush.Link.Server;

/// <summary>
/// The link's state machine, shared by every connection: who is looking at which sheet, the current version of each
/// sheet, and the one-at-a-time gate in front of the host (Revit runs one API call at a time anyway).
///
/// Versions: each sheet has an integer version that goes up by one whenever an export differs from the last one sent.
/// Every subscriber of a sheet gets every new version as a <c>sheet</c> message.
/// </summary>
public sealed class LinkHub : IAsyncDisposable
{
    private readonly ILinkHost host;
    private readonly LinkOptions options;
    private readonly ILinkLog log;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly object stateLock = new();
    private readonly Dictionary<Guid, (LinkConnection conn, HashSet<string> sheets)> clients = [];
    private readonly Dictionary<string, SheetState> sheets = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource stop = new();
    private readonly Timer debounce;
    private HashSet<string>? pendingChanged = [];
    private bool hasPendingChange;
    /// <summary>Applies and reverts waiting for the gate: a background refresh yields to them between sheets.</summary>
    private int editsWaiting;
    private IReadOnlyList<SheetSummary> lastSheetList = [];

    public LinkHub(ILinkHost host, LinkOptions options, ILinkLog log)
    {
        this.host = host;
        this.options = options;
        this.log = log;
        debounce = new Timer(_ => _ = FlushModelChangesAsync(), null, Timeout.Infinite, Timeout.Infinite);
        host.ModelChanged += OnModelChanged;
    }

    /// <summary>Random per server start. A different epoch tells the editor that versions restarted.</summary>
    public string Epoch { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();

    public int ConnectionCount
    {
        get { lock (stateLock) return clients.Count; }
    }

    private sealed class SheetState
    {
        public int Version;
        public byte[]? Hash;
        public byte[]? Package;
    }

    public async Task RunConnectionAsync(LinkConnection conn, CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, stop.Token);
        var token = linked.Token;
        var greeted = false;
        lock (stateLock) clients[conn.Id] = (conn, new HashSet<string>(StringComparer.Ordinal));
        try
        {
            while (!token.IsCancellationRequested)
            {
                var text = await conn.ReceiveAsync(token);
                if (text is null) break;
                string? requestId = null;
                try
                {
                    var msg = ClientMessageParser.Parse(text);
                    requestId = msg.RequestId;
                    if (!greeted && msg is not Hello)
                        throw new ProtocolException(ErrorCodes.NotHello, "send hello first", requestId);
                    if (msg is Hello h)
                    {
                        if (h.Protocol != LinkProtocol.Version)
                        {
                            await conn.SendAsync(ServerMessages.Error(requestId, ErrorCodes.ProtocolMismatch, $"plugin speaks protocol {LinkProtocol.Version}, editor sent {h.Protocol}"), token);
                            await conn.CloseAsync(System.Net.WebSockets.WebSocketCloseStatus.PolicyViolation, "protocol mismatch");
                            break;
                        }
                        greeted = true;
                        log.Info($"hello from {h.Client ?? "unknown client"}");
                    }
                    await HandleAsync(conn, msg, token);
                }
                catch (ProtocolException e)
                {
                    await conn.SendAsync(ServerMessages.Error(e.RequestId ?? requestId, e.Code, e.Message), token);
                }
                catch (KeyNotFoundException e)
                {
                    await conn.SendAsync(ServerMessages.Error(requestId, ErrorCodes.UnknownSheet, e.Message), token);
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    log.Error("host call failed", e);
                    await conn.SendAsync(ServerMessages.Error(requestId, ErrorCodes.HostError, e.Message), token);
                }
            }
        }
        finally
        {
            lock (stateLock) clients.Remove(conn.Id);
            log.Info("editor disconnected");
        }
    }

    private async Task HandleAsync(LinkConnection conn, ClientMessage msg, CancellationToken ct)
    {
        switch (msg)
        {
            case Hello:
            {
                var doc = await Gated(c => host.GetDocumentAsync(c), ct);
                lock (stateLock) lastSheetList = doc.Sheets;
                await conn.SendAsync(ServerMessages.Welcome("brush-revit-link", host.Name, Epoch, doc), ct);
                break;
            }
            case ListSheets:
            {
                var doc = await Gated(c => host.GetDocumentAsync(c), ct);
                lock (stateLock) lastSheetList = doc.Sheets;
                await conn.SendAsync(ServerMessages.SheetList(msg.RequestId, doc), ct);
                break;
            }
            case OpenSheet o:
            {
                lock (stateLock) clients[conn.Id].sheets.Add(o.SheetId);
                await gate.WaitAsync(ct);
                try
                {
                    var (version, package, changed) = await ExportAndVersionLockedAsync(o.SheetId, ct);
                    // The opener always gets the sheet; others who already have it open only when this is a new version.
                    await conn.SendAsync(ServerMessages.Sheet(msg.RequestId, o.SheetId, version, "open", package), ct);
                    if (changed && version > 1)
                        await BroadcastAsync(o.SheetId, ServerMessages.Sheet(null, o.SheetId, version, "model_changed", package), ct, except: conn.Id);
                }
                catch
                {
                    lock (stateLock) clients[conn.Id].sheets.Remove(o.SheetId);
                    throw;
                }
                finally
                {
                    gate.Release();
                }
                break;
            }
            case CloseSheet c:
                lock (stateLock) clients[conn.Id].sheets.Remove(c.SheetId);
                break;
            case ShowSheet sh:
                await Gated(async c => { await host.ShowSheetAsync(sh.SheetId, c); return true; }, ct);
                await conn.SendAsync(ServerMessages.Shown(msg.RequestId, sh.SheetId), ct);
                break;
            case Apply a:
            {
                await EditGateAsync(ct);
                try
                {
                    int before;
                    lock (stateLock) before = sheets.TryGetValue(a.SheetId, out var s) ? s.Version : 0;
                    var results = await host.ApplyAsync(a.SheetId, a.Commands, ct);
                    await conn.SendAsync(ServerMessages.Applied(a.RequestId, a.SheetId, a.BaseVersion, before, results), ct);
                    if (results.Any(r => r.Status == CommandStatus.Applied))
                        await RefreshEditedLockedAsync(a.SheetId, "apply", a.RequestId, ct);
                }
                finally
                {
                    gate.Release();
                }
                break;
            }
            case Revert r:
            {
                await EditGateAsync(ct);
                try
                {
                    var results = await host.RevertAsync(r.CommandIds, ct);
                    await conn.SendAsync(ServerMessages.Reverted(r.RequestId, r.SheetId, results), ct);
                    if (results.Any(x => x.Status == CommandStatus.Applied))
                        await RefreshEditedLockedAsync(r.SheetId, "revert", r.RequestId, ct);
                }
                finally
                {
                    gate.Release();
                }
                break;
            }
            case Ping:
                await conn.SendAsync(ServerMessages.Pong(msg.RequestId), ct);
                break;
        }
    }

    private async Task<T> Gated<T>(Func<CancellationToken, Task<T>> f, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            return await f(ct);
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>Export a sheet; bump its version when the bytes differ from the last export. Caller holds the gate.</summary>
    private async Task<(int version, byte[] package, bool changed)> ExportAndVersionLockedAsync(string sheetId, CancellationToken ct)
    {
        var export = await host.ExportSheetAsync(sheetId, ct);
        var manifest = new DrawingManifest { Project = export.Project, Palette = export.Palette, Sheets = [export.Sheet] };
        var package = DrawingPackage.Serialize(manifest, export.PdfName, export.Pdf);
        var hash = SHA256.HashData(package);
        lock (stateLock)
        {
            if (!sheets.TryGetValue(sheetId, out var s)) sheets[sheetId] = s = new SheetState();
            var changed = s.Hash is null || !s.Hash.AsSpan().SequenceEqual(hash);
            if (changed)
            {
                s.Version++;
                s.Hash = hash;
                s.Package = package;
            }
            return (s.Version, s.Package!, changed);
        }
    }

    /// <summary>Take the gate for an apply or revert, counted so a background refresh lets it in before its next sheet.</summary>
    private async Task EditGateAsync(CancellationToken ct)
    {
        Interlocked.Increment(ref editsWaiting);
        try
        {
            await gate.WaitAsync(ct);
        }
        finally
        {
            Interlocked.Decrement(ref editsWaiting);
        }
    }

    /// <summary>
    /// After an edit: re-export the edited sheet and push it now. Every other sheet someone has open may show the same
    /// elements (a wall shows on every plan of its level), but exporting them here kept the gate for as long as all of
    /// them took (a large sheet's PDF can take a minute), and the next edit waited behind it. They are queued for the
    /// background refresh instead, <see cref="LinkOptions.OtherSheetsAfterEditMs"/> after the last edit. Caller holds the gate.
    /// </summary>
    private async Task RefreshEditedLockedAsync(string sheetId, string reason, string? requestId, CancellationToken ct)
    {
        try
        {
            var (version, package, changed) = await ExportAndVersionLockedAsync(sheetId, ct);
            if (changed) await BroadcastAsync(sheetId, ServerMessages.Sheet(requestId, sheetId, version, reason, package), ct);
        }
        catch (KeyNotFoundException)
        {
            // The sheet was deleted in the host; the sheet list push tells the editor.
        }
        var others = SubscribedSheets();
        others.Remove(sheetId);
        if (others.Count > 0) QueueRefresh(others, options.OtherSheetsAfterEditMs);
    }

    private HashSet<string> SubscribedSheets()
    {
        lock (stateLock) return clients.Values.SelectMany(c => c.sheets).ToHashSet(StringComparer.Ordinal);
    }

    private async Task BroadcastAsync(string sheetId, JsonNode message, CancellationToken ct, Guid? except = null)
    {
        List<LinkConnection> targets;
        lock (stateLock) targets = clients.Values.Where(c => c.sheets.Contains(sheetId) && c.conn.Id != except).Select(c => c.conn).ToList();
        foreach (var c in targets)
        {
            try
            {
                await c.SendAsync(message.DeepClone(), ct);
            }
            catch (Exception e) when (e is IOException or System.Net.WebSockets.WebSocketException)
            {
                log.Info($"push to a closed connection: {e.Message}");
            }
        }
    }

    private async Task BroadcastAllAsync(JsonNode message, CancellationToken ct)
    {
        List<LinkConnection> targets;
        lock (stateLock) targets = clients.Values.Select(c => c.conn).ToList();
        foreach (var c in targets)
        {
            try
            {
                await c.SendAsync(message.DeepClone(), ct);
            }
            catch (Exception e) when (e is IOException or System.Net.WebSockets.WebSocketException)
            {
            }
        }
    }

    // ─────────────── changes made in the host, not through the link ───────────────

    private void OnModelChanged(IReadOnlyCollection<string>? sheetIds) => QueueRefresh(sheetIds, options.ModelChangeDebounceMs);

    /// <summary>Mark sheets (null: every open sheet) for the background refresh, and (re)start its timer.</summary>
    private void QueueRefresh(IReadOnlyCollection<string>? sheetIds, int delayMs)
    {
        lock (stateLock)
        {
            hasPendingChange = true;
            if (sheetIds is null) pendingChanged = null;
            else pendingChanged?.UnionWith(sheetIds);
        }
        debounce.Change(delayMs, Timeout.Infinite);
    }

    /// <summary>Run the pending model-change refresh now instead of after the debounce (tests, and hosts that know they are idle).</summary>
    public Task FlushModelChangesAsync() => FlushModelChangesAsync(stop.Token);

    private async Task FlushModelChangesAsync(CancellationToken ct)
    {
        HashSet<string>? changed;
        lock (stateLock)
        {
            if (!hasPendingChange) return;
            changed = pendingChanged;
            pendingChanged = [];
            hasPendingChange = false;
        }
        try
        {
            HashSet<string> known;
            await gate.WaitAsync(ct);
            try
            {
                var doc = await host.GetDocumentAsync(ct);
                bool listChanged;
                lock (stateLock)
                {
                    listChanged = !doc.Sheets.SequenceEqual(lastSheetList);
                    lastSheetList = doc.Sheets;
                }
                if (listChanged) await BroadcastAllAsync(ServerMessages.SheetList(null, doc), ct);
                known = doc.Sheets.Select(s => s.Id).ToHashSet(StringComparer.Ordinal);
            }
            finally
            {
                gate.Release();
            }
            // One sheet per turn of the gate: an apply or revert that comes in meanwhile goes before the next sheet, and
            // the sheets not done yet go back in the queue for after it.
            var todo = SubscribedSheets().Where(id => known.Contains(id) && (changed is null || changed.Contains(id))).ToList();
            for (var i = 0; i < todo.Count; i++)
            {
                if (Volatile.Read(ref editsWaiting) > 0)
                {
                    QueueRefresh(todo.Skip(i).ToList(), options.OtherSheetsAfterEditMs);
                    return;
                }
                await gate.WaitAsync(ct);
                try
                {
                    if (!SubscribedSheets().Contains(todo[i])) continue;
                    var (version, package, didChange) = await ExportAndVersionLockedAsync(todo[i], ct);
                    if (didChange) await BroadcastAsync(todo[i], ServerMessages.Sheet(null, todo[i], version, "model_changed", package), ct);
                }
                catch (KeyNotFoundException)
                {
                    // deleted in the host since the list was read
                }
                finally
                {
                    gate.Release();
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception e)
        {
            log.Error("refresh after model change failed", e);
        }
    }

    public ValueTask DisposeAsync()
    {
        host.ModelChanged -= OnModelChanged;
        stop.Cancel();
        debounce.Dispose();
        return ValueTask.CompletedTask;
    }
}
