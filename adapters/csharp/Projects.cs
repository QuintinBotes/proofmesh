using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Proofmesh.Adapter.CSharp;

/// <summary>A project file read as static XML. Conditions, imports, and targets are not evaluated: nothing here runs build logic.</summary>
public sealed class StaticProject
{
    public required string Path { get; init; }
    public required string Directory { get; init; }
    public required string AssemblyName { get; init; }
    public required bool Web { get; init; }
    public required bool ImplicitUsings { get; init; }
    public required bool DefaultCompileItems { get; init; }
    public List<string> ProjectReferences { get; } = [];
    public List<(string Id, string? Version)> PackageReferences { get; } = [];
    /// <summary>Packages the Directory.Build.props files above the project add, with the file that adds each.</summary>
    public List<(string Id, string? Version, string Props)> InheritedPackageReferences { get; } = [];
    public List<string> CompileIncludes { get; } = [];
    public List<string> CompileRemoves { get; } = [];
    public List<string> FrameworkReferences { get; } = [];
    /// <summary>Using items, which the SDK writes into a generated global usings file: added (with an alias or static), or removed.</summary>
    public List<(string Namespace, string? Alias, bool Static, bool Remove)> Usings { get; } = [];

    private static readonly string[] Inherited = ["ImplicitUsings", "TargetFramework", "EnableDefaultCompileItems", "LangVersion"];

    public static StaticProject Read(string workspace, string relPath, IReadOnlyDictionary<string, string> textByPath)
    {
        var doc = XDocument.Parse(textByPath[relPath]);
        var root = doc.Root!;
        var dir = System.IO.Path.GetDirectoryName(relPath)!.Replace('\\', '/');
        string? Prop(string name) => root.Descendants().Where(e => e.Name.LocalName == name).Select(e => e.Value.Trim()).LastOrDefault(v => v.Length > 0);
        var inherited = InheritedProperties(dir, textByPath);
        string? Get(string name) => Prop(name) ?? inherited.GetValueOrDefault(name);
        var sdk = (string?)root.Attribute("Sdk") ?? "";
        var p = new StaticProject
        {
            Path = relPath, Directory = dir,
            AssemblyName = Prop("AssemblyName") ?? System.IO.Path.GetFileNameWithoutExtension(relPath),
            Web = sdk.Contains("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase),
            ImplicitUsings = string.Equals(Get("ImplicitUsings"), "enable", StringComparison.OrdinalIgnoreCase) || string.Equals(Get("ImplicitUsings"), "true", StringComparison.OrdinalIgnoreCase),
            DefaultCompileItems = !string.Equals(Get("EnableDefaultCompileItems"), "false", StringComparison.OrdinalIgnoreCase),
        };
        foreach (var e in root.Descendants())
        {
            var include = ((string?)e.Attribute("Include"))?.Replace('\\', '/');
            switch (e.Name.LocalName)
            {
                case "ProjectReference" when include is not null:
                    p.ProjectReferences.Add(Normalize(System.IO.Path.Combine(dir, include)));
                    break;
                // Under central package management a project pins its own version with VersionOverride.
                case "PackageReference" when include is not null:
                    p.PackageReferences.Add((include, (string?)e.Attribute("Version") ?? (string?)e.Attribute("VersionOverride") ?? e.Elements().FirstOrDefault(x => x.Name.LocalName is "Version" or "VersionOverride")?.Value));
                    break;
                case "Using" when include is not null:
                    p.Usings.Add((include, (string?)e.Attribute("Alias"), string.Equals((string?)e.Attribute("Static"), "true", StringComparison.OrdinalIgnoreCase), false));
                    break;
                case "Using" when (string?)e.Attribute("Remove") is { } removed:
                    p.Usings.Add((removed, null, false, true));
                    break;
                case "FrameworkReference" when include is not null:
                    p.FrameworkReferences.Add(include);
                    break;
                case "Compile" when include is not null:
                    p.CompileIncludes.Add(include);
                    break;
                case "Compile" when (string?)e.Attribute("Remove") is { } remove:
                    p.CompileRemoves.Add(remove.Replace('\\', '/'));
                    break;
            }
        }
        foreach (var (id, version, props) in InheritedPackages(dir, textByPath))
            if (!p.PackageReferences.Any(r => string.Equals(r.Id, id, StringComparison.OrdinalIgnoreCase))) p.InheritedPackageReferences.Add((id, version, props));
        return p;
    }

    /// <summary>
    /// Packages the Directory.Build.props files above a project add to it, applied from the outermost file inward as MSBuild imports them: an
    /// unconditioned PackageReference Include adds one and a Remove takes it away. A conditioned group needs evaluation, so it is left out.
    /// </summary>
    private static List<(string Id, string? Version, string Props)> InheritedPackages(string dir, IReadOnlyDictionary<string, string> textByPath)
    {
        var chain = new List<string>();
        for (var d = dir; ; d = System.IO.Path.GetDirectoryName(d)?.Replace('\\', '/') ?? "")
        {
            var candidate = d.Length == 0 ? "Directory.Build.props" : $"{d}/Directory.Build.props";
            if (textByPath.ContainsKey(candidate)) chain.Add(candidate);
            if (d.Length == 0) break;
        }
        chain.Reverse();
        var result = new List<(string Id, string? Version, string Props)>();
        foreach (var props in chain)
        {
            XElement root;
            try { root = XDocument.Parse(textByPath[props]).Root!; } catch (System.Xml.XmlException) { continue; }
            foreach (var item in root.Elements().Where(g => g.Name.LocalName == "ItemGroup" && g.Attribute("Condition") is null).Elements().Where(e => e.Name.LocalName == "PackageReference" && e.Attribute("Condition") is null))
            {
                if ((string?)item.Attribute("Include") is { } id)
                {
                    result.RemoveAll(r => string.Equals(r.Id, id, StringComparison.OrdinalIgnoreCase));
                    result.Add((id, (string?)item.Attribute("Version") ?? (string?)item.Attribute("VersionOverride"), props));
                }
                else if ((string?)item.Attribute("Remove") is { } removed) result.RemoveAll(r => string.Equals(r.Id, removed, StringComparison.OrdinalIgnoreCase));
            }
        }
        return result;
    }

    /// <summary>Simple properties from the Directory.Build.props files above the project, nearest first, read statically.</summary>
    private static Dictionary<string, string> InheritedProperties(string dir, IReadOnlyDictionary<string, string> textByPath)
    {
        var result = new Dictionary<string, string>();
        for (var d = dir; ; d = System.IO.Path.GetDirectoryName(d)?.Replace('\\', '/') ?? "")
        {
            var candidate = d.Length == 0 ? "Directory.Build.props" : $"{d}/Directory.Build.props";
            if (textByPath.TryGetValue(candidate, out var text))
            {
                try
                {
                    foreach (var e in XDocument.Parse(text).Root!.Descendants())
                        if (Inherited.Contains(e.Name.LocalName) && e.Value.Trim().Length > 0) result.TryAdd(e.Name.LocalName, e.Value.Trim());
                }
                catch (System.Xml.XmlException) { }
            }
            if (d.Length == 0) break;
        }
        return result;
    }

    /// <summary>Central package versions from the nearest Directory.Packages.props, read statically.</summary>
    public static Dictionary<string, string> CentralVersions(string dir, IReadOnlyDictionary<string, string> textByPath)
    {
        for (var d = dir; ; d = System.IO.Path.GetDirectoryName(d)?.Replace('\\', '/') ?? "")
        {
            var candidate = d.Length == 0 ? "Directory.Packages.props" : $"{d}/Directory.Packages.props";
            if (textByPath.TryGetValue(candidate, out var text))
            {
                var versions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                try
                {
                    foreach (var e in XDocument.Parse(text).Root!.Descendants().Where(e => e.Name.LocalName == "PackageVersion"))
                        if ((string?)e.Attribute("Include") is { } id && (string?)e.Attribute("Version") is { } v) versions[id] = v;
                }
                catch (System.Xml.XmlException) { }
                return versions;
            }
            if (d.Length == 0) return [];
        }
    }

    public static string Normalize(string path)
    {
        var parts = new List<string>();
        foreach (var part in path.Replace('\\', '/').Split('/'))
        {
            if (part is "" or ".") continue;
            if (part == ".." && parts.Count > 0) parts.RemoveAt(parts.Count - 1);
            else parts.Add(part);
        }
        return string.Join('/', parts);
    }

    /// <summary>Byte range of the first match of a regex in a file, for evidence that points into project XML.</summary>
    public static (int Start, int End, int StartLine, int EndLine)? Locate(string text, byte[] bytes, Regex regex, int skip = 0)
    {
        var m = regex.Matches(text).Skip(skip).FirstOrDefault();
        if (m is null) return null;
        var bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0;
        var start = bom + System.Text.Encoding.UTF8.GetByteCount(text.AsSpan(0, m.Index));
        var end = start + System.Text.Encoding.UTF8.GetByteCount(text.AsSpan(m.Index, m.Length));
        var startLine = 1 + text.AsSpan(0, m.Index).Count('\n');
        var endLine = startLine + text.AsSpan(m.Index, m.Length).Count('\n');
        return (start, end, startLine, endLine);
    }
}
