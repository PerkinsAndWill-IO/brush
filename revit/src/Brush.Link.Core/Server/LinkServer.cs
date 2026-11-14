using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Brush.Link.Host;
using Brush.Link.Protocol;

namespace Brush.Link.Server;

/// <summary>
/// The live link endpoint: <c>ws://127.0.0.1:{port}/link</c> and <c>GET /health</c>.
/// A plain <see cref="TcpListener"/> on loopback plus <see cref="WebSocket.CreateFromStream(Stream, WebSocketCreationOptions)"/>:
/// no http.sys URL reservation (HttpListener needs admin rights for that on Windows), no firewall prompt, same code on every OS.
/// </summary>
public sealed class LinkServer : IAsyncDisposable
{
    private const string WebSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private const int MaxHeaderBytes = 16 * 1024;

    private readonly LinkOptions options;
    private readonly ILinkLog log;
    private readonly ILinkHost host;
    private readonly OriginPolicy origins;
    private readonly CancellationTokenSource stop = new();
    private TcpListener? listener;
    private Task? acceptLoop;

    public LinkServer(ILinkHost host, LinkOptions options, ILinkLog? log = null)
    {
        this.host = host;
        this.options = options;
        this.log = log ?? NullLinkLog.Instance;
        origins = new OriginPolicy(options, host.ApproveOriginAsync);
        Hub = new LinkHub(host, options, this.log);
    }

    public LinkHub Hub { get; }

    /// <summary>The bound port (the configured one, or the one picked when it was 0).</summary>
    public int Port { get; private set; }

    public Uri Url => new($"ws://127.0.0.1:{Port}{LinkProtocol.Path}");

    public void Start()
    {
        if (listener is not null) throw new InvalidOperationException("already started");
        listener = new TcpListener(IPAddress.Loopback, options.Port);
        listener.Start();
        Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        acceptLoop = AcceptLoopAsync(stop.Token);
        log.Info($"listening on {Url}");
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener!.AcceptTcpClientAsync(ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (SocketException e)
            {
                log.Error("accept failed", e);
                continue;
            }
            _ = Task.Run(() => HandleClientAsync(client, ct), ct);
        }
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken ct)
    {
        using (client)
        {
            client.NoDelay = true;
            var stream = client.GetStream();
            try
            {
                HttpRequestHead? req;
                using (var headerTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
                {
                    headerTimeout.CancelAfter(TimeSpan.FromSeconds(10));
                    req = await HttpRequestHead.ReadAsync(stream, MaxHeaderBytes, headerTimeout.Token);
                }
                if (req is null) return;

                // DNS rebinding: a page on evil.example resolved to 127.0.0.1 still sends Host: evil.example.
                if (!IsLoopbackHost(req.Header("host")))
                {
                    await RespondAsync(stream, 403, "Forbidden", "host not allowed", ct);
                    return;
                }
                if (req.Method == "GET" && req.Path == "/health")
                {
                    var body = new JsonObject { ["name"] = "brush-revit-link", ["protocol"] = LinkProtocol.Version, ["host"] = host.Name }.ToJsonString();
                    await RespondAsync(stream, 200, "OK", body, ct, "application/json");
                    return;
                }
                if (req.Method != "GET" || req.Path != LinkProtocol.Path)
                {
                    await RespondAsync(stream, 404, "Not Found", "not found", ct);
                    return;
                }
                var key = req.Header("sec-websocket-key");
                if (!req.HasToken("upgrade", "websocket") || !req.HasToken("connection", "upgrade") || req.Header("sec-websocket-version") != "13" || string.IsNullOrEmpty(key))
                {
                    await RespondAsync(stream, 426, "Upgrade Required", "websocket upgrade required", ct);
                    return;
                }
                var origin = req.Header("origin");
                if (!await origins.IsAllowedAsync(origin, ct))
                {
                    log.Info($"refused origin {origin ?? "(none)"}");
                    await RespondAsync(stream, 403, "Forbidden", "origin not allowed", ct);
                    return;
                }

                var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + WebSocketGuid)));
                var head = $"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(head), ct);

                using var ws = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions { IsServer = true, KeepAliveInterval = TimeSpan.FromSeconds(20) });
                log.Info($"editor connected from {origin ?? "(no origin)"}");
                await Hub.RunConnectionAsync(new LinkConnection(ws, options.MaxMessageBytes), ct);
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception e) when (e is IOException or SocketException or WebSocketException)
            {
                log.Info($"connection dropped: {e.Message}");
            }
            catch (Exception e)
            {
                log.Error("connection failed", e);
            }
        }
    }

    private bool IsLoopbackHost(string? hostHeader)
    {
        if (string.IsNullOrEmpty(hostHeader)) return false;
        var h = hostHeader.Trim().ToLowerInvariant();
        foreach (var name in new[] { "localhost", "127.0.0.1", "[::1]" })
        {
            if (h == name || h == $"{name}:{Port}") return true;
        }
        return false;
    }

    private static async Task RespondAsync(Stream stream, int status, string reason, string body, CancellationToken ct, string contentType = "text/plain; charset=utf-8")
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var head = $"HTTP/1.1 {status} {reason}\r\nContent-Type: {contentType}\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(head), ct);
        await stream.WriteAsync(bytes, ct);
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        listener?.Stop();
        if (acceptLoop is not null)
        {
            try
            {
                await acceptLoop;
            }
            catch (OperationCanceledException)
            {
            }
        }
        await Hub.DisposeAsync();
        stop.Dispose();
        log.Info("stopped");
    }
}

/// <summary>The request line and headers of an HTTP/1.1 request; enough for the WebSocket handshake.</summary>
internal sealed class HttpRequestHead
{
    private readonly Dictionary<string, string> headers;

    private HttpRequestHead(string method, string path, Dictionary<string, string> headers)
    {
        Method = method;
        Path = path;
        this.headers = headers;
    }

    public string Method { get; }
    public string Path { get; }

    public string? Header(string name) => headers.TryGetValue(name, out var v) ? v : null;

    /// <summary>A comma-separated header holds the token (case-insensitive): <c>Connection: keep-alive, Upgrade</c>.</summary>
    public bool HasToken(string header, string token) =>
        Header(header)?.Split(',').Any(t => t.Trim().Equals(token, StringComparison.OrdinalIgnoreCase)) ?? false;

    /// <summary>Reads byte by byte up to the blank line so nothing of the WebSocket stream after it is consumed.</summary>
    public static async Task<HttpRequestHead?> ReadAsync(Stream stream, int maxBytes, CancellationToken ct)
    {
        var buf = new List<byte>(1024);
        var one = new byte[1];
        while (true)
        {
            var n = await stream.ReadAsync(one, ct);
            if (n == 0) return null;
            buf.Add(one[0]);
            if (buf.Count > maxBytes) return null;
            var c = buf.Count;
            if (c >= 4 && buf[c - 4] == '\r' && buf[c - 3] == '\n' && buf[c - 2] == '\r' && buf[c - 1] == '\n') break;
        }
        var lines = Encoding.ASCII.GetString(buf.ToArray()).Split("\r\n");
        var first = lines[0].Split(' ');
        if (first.Length != 3 || !first[2].StartsWith("HTTP/1.", StringComparison.Ordinal)) return null;
        var path = first[1];
        var q = path.IndexOf('?');
        if (q >= 0) path = path[..q];
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':');
            if (colon <= 0) continue;
            var name = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            headers[name] = headers.TryGetValue(name, out var prev) ? $"{prev}, {value}" : value;
        }
        return new HttpRequestHead(first[0], path, headers);
    }
}

/// <summary>One editor connection: whole-message receive with a size cap, and sends that never interleave.</summary>
public sealed class LinkConnection(WebSocket socket, int maxMessageBytes)
{
    private readonly SemaphoreSlim sendLock = new(1, 1);

    public Guid Id { get; } = Guid.NewGuid();

    public bool IsOpen => socket.State == WebSocketState.Open;

    /// <summary>The next text message, or null when the editor closed the connection.</summary>
    public async Task<string?> ReceiveAsync(CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            var r = await socket.ReceiveAsync(buffer, ct);
            if (r.MessageType == WebSocketMessageType.Close)
            {
                await CloseAsync(WebSocketCloseStatus.NormalClosure, "bye");
                return null;
            }
            if (message.Length + r.Count > maxMessageBytes)
            {
                await CloseAsync(WebSocketCloseStatus.MessageTooBig, $"message larger than {maxMessageBytes} bytes");
                return null;
            }
            message.Write(buffer, 0, r.Count);
            if (!r.EndOfMessage) continue;
            if (r.MessageType != WebSocketMessageType.Text)
            {
                await CloseAsync(WebSocketCloseStatus.InvalidMessageType, "text frames only");
                return null;
            }
            return Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
        }
    }

    public async Task SendAsync(JsonNode message, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        await sendLock.WaitAsync(ct);
        try
        {
            if (socket.State == WebSocketState.Open) await socket.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
        }
        finally
        {
            sendLock.Release();
        }
    }

    public async Task CloseAsync(WebSocketCloseStatus status, string reason)
    {
        try
        {
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await socket.CloseOutputAsync(status, reason, CancellationToken.None);
        }
        catch (Exception e) when (e is WebSocketException or IOException or ObjectDisposedException)
        {
        }
    }
}
