# 0001 Live link: loopback WebSocket, editor formats on the wire

Date: 2026-11-14

## Context

The editor sketches on a sheet and produces commands (editor decision 0005). The spec stopped there: "Commands stop at a
log until an Applier exists." This folder is that Applier, for Revit. It works live: the editor stays connected, its
edits are applied as they are committed, and the sheet comes back as a new version.

## Decisions

1. **The editor's formats are the wire format.** Commands go in exactly as `core/commands` builds them. The sheet comes
   back as the editor's `.drawing` JSON envelope (manifest + base64 PDF, editor decisions 0002 and 0005). The editor
   can open every version with code it already has. Nothing new is defined except the message envelope
   (`docs/protocol.md`).
   - Alternative: the binary `.drawing` of `schema/` (gzip, vector items). Rejected for now because the editor does
     not read it. It is the better long-term format: the editor would get vectors instead of a PDF, and the exporter
     here would write items instead of printing. Add it as a second `package` encoding once the editor reads it.

2. **WebSocket on loopback, served by the add-in.** Revit pushes versions when the model changes in Revit, so the link
   needs a channel in both directions. The add-in listens on `127.0.0.1` with a `TcpListener` and
   `WebSocket.CreateFromStream`.
   - Alternative: `HttpListener`. Rejected because on Windows it needs an admin URL reservation for anything but
     `localhost`, and its behaviour differs by OS.
   - Alternative: Kestrel. Rejected because the ASP.NET Core runtime is not part of Revit, and shipping it inside an
     add-in invites assembly conflicts with other add-ins.
   - Alternative: a cloud relay. Rejected for v1: it needs an account, and the model leaves the machine.

3. **Security by Host and Origin.** Any page the user visits can try `ws://localhost`. The server checks the `Host`
   header against loopback names (this stops DNS rebinding). It checks `Origin` against an allow list, and Revit asks
   the user about any other origin, once per session or always. The `null` origin is never allowed.

4. **Revit-free core.** The protocol, the server, the sheet-to-model math and the package writer live in
   `Brush.Link.Core` (net8.0, no dependencies), with unit and socket tests that run on any OS. The add-in is a thin
   layer that reads geometry out of Revit and executes the planned operations. `PackageHost` and the DevHost run the
   same core over an editor fixture, so editor work does not need Windows or Revit.

5. **One Undo step per batch, one transaction per command.** A batch is a `TransactionGroup` that is assimilated at
   the end. Each command runs in its own `Transaction`, so one bad command does not lose the rest. Warnings are
   swallowed and reported back as notes, so no dialog interrupts a live session.

6. **Revit 2025 and later.** These versions run on .NET 8 (2027 on .NET 10). The add-in builds against the
   `Nice3point.Revit.Api.*` reference packages. They contain reference assemblies only, are not shipped with the
   add-in, and let CI and Linux compile it. Revit 2024 and earlier run on .NET Framework 4.8 and are out of scope.

## Consequences

- Every version carries the whole PDF (an A0 sheet can be several MB of base64). That is fine on loopback. Diffing
  versions is a later optimization.
- Exporting a sheet to PDF takes Revit from about half a second to several seconds, and the plugin does one export per
  apply. Batching commands in the editor matters more than the speed of the protocol.
- Sheet ids are Revit element ids, not sheet numbers, so renumbering a sheet keeps the editor's session valid.
