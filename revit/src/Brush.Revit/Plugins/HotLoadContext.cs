using System.Reflection;
using System.Runtime.Loader;

namespace Brush.Revit.Plugins;

/// <summary>
/// A collectible load context for one copy of the plugin. Assemblies found in the plugin folder are read into memory
/// and loaded from the bytes, so the files are never locked and a build can overwrite them while Revit runs.
///
/// The shim assembly itself always resolves to the copy Revit already loaded, so <see cref="IBrushPlugin"/> and
/// <see cref="RevitDispatcher"/> are the same types on both sides. Anything not in the plugin folder (RevitAPI,
/// RevitAPIUI, the framework) falls through to the default context.
/// </summary>
internal sealed class HotLoadContext(string folder, int generation) : AssemblyLoadContext($"Brush plugin #{generation}", isCollectible: true)
{
    private static readonly Assembly Shim = typeof(HotLoadContext).Assembly;

    public Assembly LoadPlugin(string assemblyName) => LoadFromFolder(new AssemblyName(assemblyName))
        ?? throw new FileNotFoundException($"{assemblyName}.dll is not in {folder}");

    protected override Assembly? Load(AssemblyName name)
    {
        if (AssemblyName.ReferenceMatchesDefinition(name, Shim.GetName()) || name.Name == Shim.GetName().Name) return Shim;
        return LoadFromFolder(name);
    }

    private Assembly? LoadFromFolder(AssemblyName name)
    {
        var dll = Path.Combine(folder, name.Name + ".dll");
        if (!File.Exists(dll)) return null;
        var pdb = Path.ChangeExtension(dll, ".pdb");
        // Read the PDB too, so stack traces and breakpoints still have line numbers.
        using var dllStream = new MemoryStream(ReadShared(dll));
        using var pdbStream = File.Exists(pdb) ? new MemoryStream(ReadShared(pdb)) : null;
        return LoadFromStream(dllStream, pdbStream);
    }

    /// <summary>Read a file another process (the build) may still be writing: allow sharing and retry briefly.</summary>
    internal static byte[] ReadShared(string path)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                using var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var ms = new MemoryStream();
                f.CopyTo(ms);
                return ms.ToArray();
            }
            catch (IOException) when (attempt < 10)
            {
                Thread.Sleep(100);
            }
        }
    }
}
