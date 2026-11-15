namespace Brush.Link.Planning;

/// <summary>A type an element could take: its name and, for a family type, its family.</summary>
public sealed record TypeCandidate<T>(T Value, string Name, string? Family)
{
    /// <summary>How the sheet names it: <c>Family: Type</c> for a family type, the name alone otherwise.</summary>
    public string Key => Family is { Length: > 0 } f ? $"{f}: {Name}" : Name;
}

/// <summary>The type a <c>set_type</c> asked for, the one picked (<see cref="Hit"/>), and why, or why none was.</summary>
public sealed record TypeMatchResult<T>(TypeCandidate<T>? Hit, string? Note, string? Error);

/// <summary>
/// Finds the type a <c>set_type</c> names among the types an element can take. Pure, so Revit and the DevHost pick the
/// same way. In order:
/// <list type="number">
/// <item>family and name exactly (with no family: the name, or <c>Family: Type</c>);</item>
/// <item>the same, ignoring case;</item>
/// <item>the closest match, with a note: a type of that name in another family, or, for <c>Family: Type</c> with no
/// such family, the type name alone;</item>
/// <item>otherwise an error that lists the types there are.</item>
/// </list>
/// </summary>
public static class TypeMatch
{
    public static TypeMatchResult<T> Find<T>(IReadOnlyList<TypeCandidate<T>> candidates, string typeName, string? family, string what)
    {
        var (name, fam) = CommandPlanner.TypeQuery(typeName, family);
        var wanted = fam is null ? name : $"{fam}: {name}";
        foreach (var cmp in new[] { StringComparer.Ordinal, StringComparer.OrdinalIgnoreCase })
        {
            if (fam is not null)
            {
                if (candidates.FirstOrDefault(c => cmp.Equals(c.Family, fam) && cmp.Equals(c.Name, name)) is { } hit) return new(hit, null, null);
                continue;
            }
            if (candidates.FirstOrDefault(c => cmp.Equals(c.Key, name)) is { } byKey) return new(byKey, null, null);
            var byName = candidates.Where(c => cmp.Equals(c.Name, name)).ToList();
            if (byName.Count == 1) return new(byName[0], null, null);
            if (byName.Count > 1) return new(byName[0], $"'{name}' is a type of {byName.Count} families, used '{byName[0].Key}'", null);
        }

        // Closest: the type name in another family ("Family: Type" with no family given splits like a key).
        var sep = name.IndexOf(": ", StringComparison.Ordinal);
        var typeOnly = fam is not null ? name : sep > 0 ? name[(sep + 2)..] : null;
        if (typeOnly is not null && candidates.FirstOrDefault(c => StringComparer.OrdinalIgnoreCase.Equals(c.Name, typeOnly)) is { } near)
            return new(near, $"no {what} type '{wanted}', used '{near.Key}'", null);

        var keys = candidates.Select(c => c.Key).Distinct().OrderBy(k => k, StringComparer.OrdinalIgnoreCase).ToList();
        var have = keys.Count == 0 ? "there is none" : $"there are {string.Join(", ", keys.Take(8).Select(k => $"'{k}'"))}{(keys.Count > 8 ? $" and {keys.Count - 8} more" : "")}";
        return new(null, null, $"no {what} type '{wanted}' in this model; {have}");
    }
}
