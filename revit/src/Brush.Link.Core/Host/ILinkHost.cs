using Brush.Link.Model;

namespace Brush.Link.Host;

/// <summary>
/// What the link needs from the modelling app. Revit implements it in <c>Brush.Revit</c> (every call marshalled onto
/// Revit's API thread); <c>Brush.Link.DevHost</c> implements it over an editor fixture package.
/// The hub never calls two methods at once.
/// </summary>
public interface ILinkHost
{
    /// <summary>"Revit 2026", "DevHost": shown to the user in the editor.</summary>
    string Name { get; }

    Task<DocumentInfo> GetDocumentAsync(CancellationToken ct);

    /// <summary>The current state of one sheet: its manifest entry, the model's type palette, and the sheet as PDF.</summary>
    Task<SheetExport> ExportSheetAsync(string sheetId, CancellationToken ct);

    /// <summary>
    /// Apply the commands in order, all in one undoable step in the host. A command that fails does not stop the
    /// others; its result says why. Results are in command order.
    /// </summary>
    Task<IReadOnlyList<CommandResult>> ApplyAsync(string sheetId, IReadOnlyList<Command> commands, CancellationToken ct);

    /// <summary>Undo earlier commands of this link: delete the elements they created. Used for the editor's undo.</summary>
    Task<IReadOnlyList<CommandResult>> RevertAsync(IReadOnlyList<string> commandIds, CancellationToken ct);

    /// <summary>
    /// S1-06: the types <paramref name="elementId"/> can switch to, as the host lists them, and its current type.
    /// Throws <see cref="KeyNotFoundException"/> for an unknown element.
    /// </summary>
    Task<TypeList> ListTypesAsync(string elementId, CancellationToken ct);

    /// <summary>Make the sheet the active view in the host. Throws <see cref="KeyNotFoundException"/> for an unknown sheet.</summary>
    Task ShowSheetAsync(string sheetId, CancellationToken ct);

    /// <summary>Ask the user whether a web page from <paramref name="origin"/> may edit the open model.</summary>
    Task<bool> ApproveOriginAsync(string origin, CancellationToken ct);

    /// <summary>
    /// Raised (on any thread) when the model changed outside the link, with the ids of sheets that may look different,
    /// or null when the host cannot tell (all open sheets are re-exported). Also raised when the sheet list changes.
    /// </summary>
    event Action<IReadOnlyCollection<string>?>? ModelChanged;
}

/// <param name="Views">S1-06: the model's views (plans, sections, elevations, 3D) that edits may be addressed to.</param>
public sealed record DocumentInfo(string Title, string? Path, string? Project, IReadOnlyList<SheetSummary> Sheets, IReadOnlyList<ViewSummary>? Views = null);

public sealed record ViewSummary(string Id, string Name, string Kind);

/// <summary>S1-06: a type an element can take. <see cref="TypeId"/> is the host's id for it.</summary>
public sealed record TypeInfo(string? Family, string TypeName, string TypeId);

public sealed record TypeList(string ElementId, TypeInfo? Current, IReadOnlyList<TypeInfo> Types);

public sealed record SheetSummary(string Id, string? Number, string Name);

public sealed record SheetExport(ManifestSheet Sheet, TypePalette? Palette, string? Project, string? PdfName, byte[]? Pdf);

public static class CommandStatus
{
    public const string Applied = "applied";
    /// <summary>Not applied, nothing wrong with the model (unknown op, target already gone).</summary>
    public const string Skipped = "skipped";
    public const string Failed = "failed";
}

/// <summary>
/// The outcome of one command. <see cref="ElementIds"/> are the Revit elements it created (or deleted, for a delete).
/// <see cref="Notes"/> say what was approximated: "no door type named X, used Y".
/// </summary>
public sealed record CommandResult(string Id, string Status, IReadOnlyList<string> ElementIds, string? Message = null, IReadOnlyList<string>? Notes = null)
{
    public static CommandResult Applied(string id, IReadOnlyList<string> elements, IReadOnlyList<string>? notes = null) =>
        new(id, CommandStatus.Applied, elements, null, notes is { Count: > 0 } ? notes : null);

    public static CommandResult Skipped(string id, string why) => new(id, CommandStatus.Skipped, [], why);

    public static CommandResult Failed(string id, string why) => new(id, CommandStatus.Failed, [], why);
}

/// <summary>
/// Which elements each command of this link created, so delete-by-command and revert can find them.
/// The backing store can be handed in so it outlives this object (the Revit add-in keeps it across hot reloads);
/// it only holds BCL types for that reason.
/// </summary>
public sealed class CommandLedger(Dictionary<string, List<string>> created)
{
    private readonly object gate = created;

    public CommandLedger() : this(new Dictionary<string, List<string>>(StringComparer.Ordinal)) { }

    public void Record(string commandId, IEnumerable<string> elementIds)
    {
        lock (gate) created[commandId] = elementIds.ToList();
    }

    public bool Knows(string commandId)
    {
        lock (gate) return created.ContainsKey(commandId);
    }

    public IReadOnlyList<string> ElementsOf(string commandId)
    {
        lock (gate) return created.TryGetValue(commandId, out var l) ? l.ToList() : [];
    }

    public void Forget(string commandId)
    {
        lock (gate)
        {
            created.Remove(commandId);
            created.Remove(TypeChangeKey(commandId));
        }
    }

    // S1-06: the previous type of each element a change_type switched, so revert can set it back. Kept in the same
    // shared dictionary as the created elements (under a key no command id can have), so it survives a new ledger
    // per call and a hot reload like the rest. Entries are "elementId|previousTypeId".
    private const string TypeChangePrefix = "type-change:";

    private static string TypeChangeKey(string commandId) => TypeChangePrefix + commandId;

    /// <summary>Record an applied change_type: the command is known, and what each element's type was before.</summary>
    public void RecordTypeChange(string commandId, IReadOnlyList<(string ElementId, string PreviousTypeId)> changes)
    {
        lock (gate)
        {
            created[commandId] = [];
            created[TypeChangeKey(commandId)] = changes.Select(c => $"{c.ElementId}|{c.PreviousTypeId}").ToList();
        }
    }

    /// <summary>The elements a change_type switched and their previous types; empty for any other command.</summary>
    public IReadOnlyList<(string ElementId, string PreviousTypeId)> TypeChangesOf(string commandId)
    {
        lock (gate)
        {
            if (!created.TryGetValue(TypeChangeKey(commandId), out var l)) return [];
            return l.Select(e => e.Split('|', 2)).Where(p => p.Length == 2).Select(p => (p[0], p[1])).ToList();
        }
    }
}
