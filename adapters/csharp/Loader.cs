using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Proofmesh.Adapter.CSharp;

/// <param name="DependenciesMissing">Some referenced package could not be loaded, so an unbound name may come from it.</param>
public sealed record LoadedProject(string Name, string ProjectPath, string Directory, Compilation Compilation, List<SyntaxTree> Trees, StaticProject? Static, bool DependenciesMissing, IReadOnlyList<string>? MissingPackages = null);

public sealed record CapturedWorkspace(string Root, IReadOnlyList<string> SourceFiles, IReadOnlyDictionary<string, string> ConfigText);

public static class Toolchain
{
    public static string DotnetRoot()
    {
        var env = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (env is not null && System.IO.Directory.Exists(System.IO.Path.Combine(env, "packs"))) return env;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(System.IO.Path.PathSeparator))
        {
            var exe = System.IO.Path.Combine(dir, "dotnet");
            if (!File.Exists(exe)) continue;
            var real = new FileInfo(exe).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? exe;
            var root = System.IO.Path.GetDirectoryName(real)!;
            if (System.IO.Directory.Exists(System.IO.Path.Combine(root, "packs"))) return root;
        }
        return System.IO.Path.GetDirectoryName(typeof(object).Assembly.Location)!;
    }

    public static string? PackDirectory(string pack)
    {
        var dir = System.IO.Path.Combine(DotnetRoot(), "packs", pack);
        if (!System.IO.Directory.Exists(dir)) return null;
        var version = System.IO.Directory.GetDirectories(dir).Select(System.IO.Path.GetFileName).Where(v => v!.StartsWith("10.")).OrderByDescending(v => Version.TryParse(v!.Split('-')[0], out var p) ? p : new Version()).FirstOrDefault();
        var refDir = version is null ? null : System.IO.Path.Combine(dir, version, "ref", "net10.0");
        return refDir is not null && System.IO.Directory.Exists(refDir) ? refDir : null;
    }

    public static string NuGetRoot() => Environment.GetEnvironmentVariable("NUGET_PACKAGES") ?? System.IO.Path.Combine(Environment.GetEnvironmentVariable("HOME") ?? "", ".nuget", "packages");

    // .NET Framework builds come last: the reference packs' mscorlib and netstandard facades let most of them bind.
    private static readonly string[] Tfms = ["net10.0", "net9.0", "net8.0", "net7.0", "net6.0", "net5.0", "netcoreapp3.1", "netstandard2.1", "netstandard2.0", "netstandard1.6", "net48", "net472", "net471", "net47", "net462", "net461", "net46", "net452", "net451", "net45"];

    /// <summary>Assemblies of a package already in the NuGet cache. Nothing is downloaded.</summary>
    /// <summary>A package as an external input: its id and version with NuGet's own recorded hash, or marked missing.</summary>
    public static string PackageInput(string id, string? version)
    {
        var dir = System.IO.Path.Combine(NuGetRoot(), id.ToLowerInvariant());
        var chosen = !System.IO.Directory.Exists(dir) ? null
            : version is not null && System.IO.Directory.Exists(System.IO.Path.Combine(dir, version.ToLowerInvariant())) ? version.ToLowerInvariant()
            : System.IO.Directory.GetDirectories(dir).Select(System.IO.Path.GetFileName).OrderByDescending(v => v, StringComparer.Ordinal).FirstOrDefault();
        var sha = chosen is null ? null : System.IO.Path.Combine(dir, chosen, $"{id.ToLowerInvariant()}.{chosen}.nupkg.sha512");
        return sha is not null && File.Exists(sha) ? $"nuget:{id}/{chosen} sha512:{File.ReadAllText(sha).Trim()}" : $"nuget:{id}/{version ?? "?"} missing";
    }

    /// <summary>
    /// The packages a cached package depends on for this target, from its .nuspec: the group of the nearest target framework, or the
    /// group without one. A version range gives its lower bound. Nothing is downloaded; an absent package has no dependencies to read.
    /// </summary>
    public static IReadOnlyList<(string Id, string? Version)> PackageDependencies(string id, string? version)
    {
        var dir = System.IO.Path.Combine(NuGetRoot(), id.ToLowerInvariant());
        if (!System.IO.Directory.Exists(dir)) return [];
        var chosen = version is not null && System.IO.Directory.Exists(System.IO.Path.Combine(dir, version.ToLowerInvariant())) ? version.ToLowerInvariant()
            : System.IO.Directory.GetDirectories(dir).Select(System.IO.Path.GetFileName).OrderByDescending(v => v, StringComparer.Ordinal).FirstOrDefault();
        var nuspec = chosen is null ? null : System.IO.Directory.GetFiles(System.IO.Path.Combine(dir, chosen), "*.nuspec").FirstOrDefault();
        if (nuspec is null) return [];
        System.Xml.Linq.XElement root;
        try { root = System.Xml.Linq.XDocument.Load(nuspec).Root!; } catch (System.Xml.XmlException) { return []; }
        var groups = root.Descendants().Where(e => e.Name.LocalName == "group").ToList();
        var deps = groups.Count == 0 ? root.Descendants().Where(e => e.Name.LocalName == "dependency")
            : (Tfms.Select(t => groups.FirstOrDefault(g => Normalize((string?)g.Attribute("targetFramework")) == t)).FirstOrDefault(g => g is not null)
               ?? groups.FirstOrDefault(g => g.Attribute("targetFramework") is null))?.Elements().Where(e => e.Name.LocalName == "dependency") ?? [];
        return deps.Select(d => ((string?)d.Attribute("id") ?? "", LowerBound((string?)d.Attribute("version")))).Where(d => d.Item1.Length > 0).ToList();

        static string? LowerBound(string? range) => range?.Trim('[', '(', ' ').Split(',')[0].Trim() is { Length: > 0 } v ? v : null;
        // nuspec groups write ".NETStandard2.0", "net8.0" or ".NETFramework4.5"; the list above writes netstandard2.0, net8.0, net45.
        static string? Normalize(string? tfm) => tfm?.ToLowerInvariant() switch
        {
            null => null,
            var t when t.StartsWith(".netstandard", StringComparison.Ordinal) => "netstandard" + t[".netstandard".Length..],
            var t when t.StartsWith(".netcoreapp", StringComparison.Ordinal) => "netcoreapp" + t[".netcoreapp".Length..],
            var t when t.StartsWith(".netframework", StringComparison.Ordinal) => "net" + t[".netframework".Length..].Replace(".", ""),
            var t => t,
        };
    }

    /// <summary>Whether NuGet's cache holds the package, by its recorded hash. A package with no compile assemblies, such as a test adapter,
    /// an analyzer or a native runtime, is present and simply adds no references.</summary>
    public static bool InCache(string id, string? version) => !PackageInput(id, version).EndsWith(" missing", StringComparison.Ordinal);

    /// <summary>A reference pack as an external input: its name and version.</summary>
    public static string? PackInput(string name) => PackDirectory(name) is { } d ? $"pack:{name}/{System.IO.Path.GetFileName(System.IO.Path.GetDirectoryName(System.IO.Path.GetDirectoryName(d))!)}" : null;

    public static IEnumerable<string> PackageAssemblies(string id, string? version)
    {
        var dir = System.IO.Path.Combine(NuGetRoot(), id.ToLowerInvariant());
        if (!System.IO.Directory.Exists(dir)) return [];
        var chosen = version is not null && System.IO.Directory.Exists(System.IO.Path.Combine(dir, version.ToLowerInvariant())) ? version.ToLowerInvariant()
            : System.IO.Directory.GetDirectories(dir).Select(System.IO.Path.GetFileName).OrderByDescending(v => v, StringComparer.Ordinal).FirstOrDefault();
        if (chosen is null) return [];
        foreach (var kind in new[] { "ref", "lib" })
            foreach (var tfm in Tfms)
            {
                var d = System.IO.Path.Combine(dir, chosen, kind, tfm);
                if (System.IO.Directory.Exists(d)) return System.IO.Directory.GetFiles(d, "*.dll");
            }
        return [];
    }
}

/// <summary>Builds compilations from source files and reference assemblies on disk. No MSBuild evaluation, restore, analyzers, or source generators.</summary>
public static class NoExecutionLoader
{
    private static readonly string[] Symbols = ["NET", "NETCOREAPP", "NET10_0", "NET5_0_OR_GREATER", "NET6_0_OR_GREATER", "NET7_0_OR_GREATER", "NET8_0_OR_GREATER", "NET9_0_OR_GREATER", "NET10_0_OR_GREATER", "DEBUG", "TRACE"];
    private static readonly CSharpParseOptions Parse = new(LanguageVersion.Preview, DocumentationMode.None, SourceCodeKind.Regular, Symbols);
    /// <summary>The global usings the SDK would generate: the implicit ones when enabled, less those a Using item removes, plus the Using items.</summary>
    public static string GlobalUsings(StaticProject p)
    {
        var namespaces = p.ImplicitUsings ? (p.Web ? CoreUsings + WebUsings : CoreUsings).Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(u => u["global using global::".Length..]).ToList() : [];
        var lines = new List<string>();
        foreach (var u in p.Usings.Where(u => u.Remove)) namespaces.RemoveAll(n => n == u.Namespace);
        lines.AddRange(namespaces.Select(n => $"global using global::{n};"));
        foreach (var u in p.Usings.Where(u => !u.Remove))
            lines.Add(u.Alias is { } alias ? $"global using {alias} = global::{u.Namespace};" : u.Static ? $"global using static global::{u.Namespace};" : $"global using global::{u.Namespace};");
        return string.Join("\n", lines.Distinct());
    }

    private const string CoreUsings = "global using global::System; global using global::System.Collections.Generic; global using global::System.IO; global using global::System.Linq; global using global::System.Net.Http; global using global::System.Threading; global using global::System.Threading.Tasks;";
    private const string WebUsings = " global using global::System.Net.Http.Json; global using global::Microsoft.AspNetCore.Builder; global using global::Microsoft.AspNetCore.Hosting; global using global::Microsoft.AspNetCore.Http; global using global::Microsoft.AspNetCore.Routing; global using global::Microsoft.Extensions.Configuration; global using global::Microsoft.Extensions.DependencyInjection; global using global::Microsoft.Extensions.Hosting; global using global::Microsoft.Extensions.Logging;";

    public static List<LoadedProject> Load(CapturedWorkspace ws, DeclarationIndex index, Dictionary<string, SyntaxTree> treeByPath, List<Diagnostic> diagnostics, Action<string> progress, SortedSet<string> inputs)
    {
        var missing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var unevaluated = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var projects = new List<StaticProject>();
        foreach (var path in ws.ConfigText.Keys.Where(p => p.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)).Order(StringComparer.Ordinal))
        {
            try { projects.Add(StaticProject.Read(ws.Root, path, ws.ConfigText)); }
            catch (System.Xml.XmlException ex) { diagnostics.Add(new Diagnostic("warning", $"project file is not well-formed XML: {ex.Message}", path)); }
        }
        var core = MetadataFrom(Toolchain.PackDirectory("Microsoft.NETCore.App.Ref"));
        var aspnet = MetadataFrom(Toolchain.PackDirectory("Microsoft.AspNetCore.App.Ref"));
        if (core.Count == 0) diagnostics.Add(new Diagnostic("warning", "Microsoft.NETCore.App.Ref 10.x was not found; framework calls stay unresolved"));

        var byDirLength = projects.OrderByDescending(p => p.Directory.Length).ToList();
        StaticProject? OwnerOf(string file) => byDirLength.FirstOrDefault(p => p.Directory.Length == 0 || file.StartsWith(p.Directory + "/", StringComparison.Ordinal));
        var members = projects.ToDictionary(p => p.Path, _ => new List<string>());
        var loose = new List<string>();
        foreach (var f in ws.SourceFiles)
        {
            var owner = OwnerOf(f);
            if (owner is not null && owner.DefaultCompileItems) members[owner.Path].Add(f);
            else if (owner is null) loose.Add(f);
        }
        foreach (var p in projects)
        {
            foreach (var include in p.CompileIncludes)
            {
                var regex = Glob(StaticProject.Normalize(System.IO.Path.Combine(p.Directory, include)));
                members[p.Path].AddRange(ws.SourceFiles.Where(f => regex.IsMatch(f) && !members[p.Path].Contains(f)));
            }
            foreach (var remove in p.CompileRemoves)
            {
                var regex = Glob(StaticProject.Normalize(System.IO.Path.Combine(p.Directory, remove)));
                members[p.Path].RemoveAll(regex.IsMatch);
            }
        }

        var loaded = new Dictionary<string, LoadedProject>();
        var visiting = new HashSet<string>();
        var dependencyCache = new Dictionary<string, IReadOnlyList<(string Id, string? Version)>>(StringComparer.OrdinalIgnoreCase);
        // Assembly names the reference packs carry: a package of the same name is already part of the framework.
        var framework = new HashSet<string>(core.OfType<PortableExecutableReference>().Select(r => System.IO.Path.GetFileNameWithoutExtension(r.FilePath!)), StringComparer.OrdinalIgnoreCase) { "NETStandard.Library", "Microsoft.NETCore.Platforms", "Microsoft.NETCore.Targets" };
        var aspnetNames = new HashSet<string>(aspnet.OfType<PortableExecutableReference>().Select(r => System.IO.Path.GetFileNameWithoutExtension(r.FilePath!)), StringComparer.OrdinalIgnoreCase);
        LoadedProject? Build(StaticProject p)
        {
            if (loaded.TryGetValue(p.Path, out var done)) return done;
            if (!visiting.Add(p.Path)) return null;
            progress($"loading {p.AssemblyName}");
            var refs = new List<MetadataReference>(core);
            var dependenciesMissing = false;
            var lacking = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            if (p.Web || p.FrameworkReferences.Contains("Microsoft.AspNetCore.App")) refs.AddRange(aspnet);
            var central = StaticProject.CentralVersions(p.Directory, ws.ConfigText);
            // A restore brings in what each package depends on, so the packages are walked through their dependencies; a package whose
            // assembly the framework reference pack already has is left to the pack, so no type is defined twice.
            var queue = new Queue<(string Id, string? Version, bool Direct)>(p.PackageReferences.Concat(p.InheritedPackageReferences.Select(r => (r.Id, r.Version))).Select(r => (r.Item1, r.Item2, true)));
            var seenPackages = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (queue.TryDequeue(out var next))
            {
                var (id, version, direct) = next;
                if (!seenPackages.Add(id)) continue;
                if (!direct && (framework.Contains(id) || (p.Web || p.FrameworkReferences.Contains("Microsoft.AspNetCore.App")) && aspnetNames.Contains(id))) continue;
                var chosen = version ?? central.GetValueOrDefault(id);
                // An id or version written with an MSBuild property needs evaluation the static reader does not do: the reference is
                // named as unevaluated, not as missing, so it does not turn every unbound symbol of the project into dependency_missing.
                if (id.Contains("$(", StringComparison.Ordinal) || chosen?.Contains("$(", StringComparison.Ordinal) == true)
                {
                    unevaluated.Add(id);
                    inputs.Add($"nuget:{id}/{chosen ?? "?"} unevaluated");
                    continue;
                }
                var dlls = Toolchain.PackageAssemblies(id, chosen).ToList();
                inputs.Add(Toolchain.PackageInput(id, chosen));
                if (dlls.Count == 0 && !Toolchain.InCache(id, chosen)) { missing.Add(id); lacking.Add(id); dependenciesMissing = true; }
                refs.AddRange(dlls.Select(d => MetadataReference.CreateFromFile(d)));
                foreach (var (dep, depVersion) in dependencyCache.TryGetValue($"{id}/{chosen}", out var known) ? known : dependencyCache[$"{id}/{chosen}"] = Toolchain.PackageDependencies(id, chosen))
                    queue.Enqueue((dep, central.GetValueOrDefault(dep) ?? depVersion, false));
            }
            foreach (var r in p.ProjectReferences)
            {
                var dep = projects.FirstOrDefault(x => x.Path == r);
                // MSBuild flows project and package references transitively, so a project sees everything its references see.
                // shortcut: PrivateAssets="all" packages flow here too; honour it if a wrongly bound type ever shows up in a parity check.
                if (dep is not null && Build(dep) is { } built) { refs.Add(built.Compilation.ToMetadataReference()); refs.AddRange(built.Compilation.References); dependenciesMissing |= built.DependenciesMissing; lacking.UnionWith(built.MissingPackages ?? []); }
            }
            var trees = members[p.Path].Select(f => Tree(ws, f, index, treeByPath)).ToList();
            var all = new List<SyntaxTree>(trees);
            if (GlobalUsings(p) is { Length: > 0 } usings) all.Add(CSharpSyntaxTree.ParseText(usings, Parse));
            // One assembly per name, as a build's conflict resolution leaves: the reference packs come first, then the project's own
            // packages, then what its project references bring, so a project's pinned version wins over a referenced project's.
            var compilation = CSharpCompilation.Create(p.AssemblyName, all, refs.DistinctBy(AssemblyNameOf, StringComparer.OrdinalIgnoreCase), Options);
            var lp = new LoadedProject(p.AssemblyName, p.Path, p.Directory, compilation, trees, p, dependenciesMissing, lacking.ToList());
            loaded[p.Path] = lp;
            return lp;
        }
        var result = projects.Select(Build).OfType<LoadedProject>().ToList();
        if (missing.Count > 0) diagnostics.Add(new Diagnostic("warning", $"{missing.Count} referenced packages are not in the NuGet cache; their types stay unresolved (dependency_missing)"));
        if (unevaluated.Count > 0) diagnostics.Add(new Diagnostic("warning", $"{unevaluated.Count} package references are written with MSBuild properties ({string.Join(", ", unevaluated.Order(StringComparer.OrdinalIgnoreCase).Take(3))}{(unevaluated.Count > 3 ? ", …" : "")}) that the static reader cannot evaluate; they are recorded as unevaluated inputs and add no references"));
        if (loose.Count > 0)
        {
            var trees = loose.Select(f => Tree(ws, f, index, treeByPath)).ToList();
            result.Add(new LoadedProject("(loose files)", "", "", CSharpCompilation.Create("loose", trees, core, Options), trees, null, DependenciesMissing: false));
        }
        return result;
    }

    public static readonly CSharpCompilationOptions Options = new(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable, allowUnsafe: true, concurrentBuild: true);

    /// <summary>The assembly a reference stands for: a project's assembly name, or a file's name without its .dll.</summary>
    public static string AssemblyNameOf(MetadataReference r) => r is CompilationReference c ? c.Compilation.AssemblyName ?? "" : System.IO.Path.GetFileNameWithoutExtension(r.Display ?? "");

    private static List<MetadataReference> MetadataFrom(string? dir) =>
        dir is null ? [] : System.IO.Directory.GetFiles(dir, "*.dll").Select(d => (MetadataReference)MetadataReference.CreateFromFile(d)).ToList();

    private static SyntaxTree Tree(CapturedWorkspace ws, string rel, DeclarationIndex index, Dictionary<string, SyntaxTree> treeByPath)
    {
        if (treeByPath.TryGetValue(rel, out var existing)) return existing;
        var bytes = File.ReadAllBytes(System.IO.Path.Combine(ws.Root, rel));
        var tree = CSharpSyntaxTree.ParseText(SourceText.From(bytes, bytes.Length, Encoding.UTF8, canBeEmbedded: false), Parse, System.IO.Path.Combine(ws.Root, rel));
        index.AddTree(tree, rel, bytes);
        treeByPath[rel] = tree;
        return tree;
    }

    private static Regex Glob(string pattern) =>
        new("^" + Regex.Escape(pattern).Replace(@"\*\*/", "(.*/)?").Replace(@"\*\*", ".*").Replace(@"\*", "[^/]*").Replace(@"\?", "[^/]") + "$", RegexOptions.CultureInvariant);
}

/// <summary>Trusted-build mode, only under a trust grant: restore and MSBuild evaluation run in the staging copy, never in the repository.</summary>
public static class TrustedLoader
{
    public static async Task<List<LoadedProject>> LoadAsync(CapturedWorkspace ws, DeclarationIndex index, Dictionary<string, SyntaxTree> treeByPath, List<Diagnostic> diagnostics, Action<string> progress)
    {
        var entries = ws.ConfigText.Keys.Where(p => !p.Contains('/') && (p.EndsWith(".sln") || p.EndsWith(".slnx"))).ToList();
        if (entries.Count == 0) entries = ws.ConfigText.Keys.Where(p => p.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)).ToList();
        var restoreFailed = false;
        foreach (var entry in entries)
        {
            var restore = Process.Start(new ProcessStartInfo("dotnet", ["restore", entry, "--verbosity", "quiet"]) { WorkingDirectory = ws.Root, RedirectStandardOutput = true, RedirectStandardError = true })!;
            await restore.StandardOutput.ReadToEndAsync();
            await restore.WaitForExitAsync();
            restoreFailed |= restore.ExitCode != 0;
            if (restore.ExitCode != 0) diagnostics.Add(new Diagnostic("warning", $"dotnet restore {entry} exited with {restore.ExitCode}; resolution may be partial"));
        }
        using var workspace = MSBuildWorkspace.Create(new Dictionary<string, string> { ["Configuration"] = "Debug" });
        workspace.RegisterWorkspaceFailedHandler(e => { if (e.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure) diagnostics.Add(new Diagnostic("warning", e.Diagnostic.Message)); });
        var solution = workspace.CurrentSolution;
        foreach (var entry in entries)
        {
            var full = System.IO.Path.Combine(ws.Root, entry);
            if (entry.EndsWith(".csproj")) { if (!solution.Projects.Any(p => p.FilePath == full)) { await workspace.OpenProjectAsync(full); solution = workspace.CurrentSolution; } }
            else solution = await workspace.OpenSolutionAsync(full);
        }
        var sources = ws.SourceFiles.ToHashSet(StringComparer.Ordinal);
        var result = new List<LoadedProject>();
        foreach (var project in solution.Projects.Where(p => p.Language == LanguageNames.CSharp))
        {
            progress($"loading {project.Name}");
            var compilation = await project.GetCompilationAsync();
            if (compilation is null) continue;
            var rel = System.IO.Path.GetRelativePath(ws.Root, project.FilePath!).Replace('\\', '/');
            var trees = new List<SyntaxTree>();
            foreach (var tree in compilation.SyntaxTrees)
            {
                var path = System.IO.Path.GetRelativePath(ws.Root, tree.FilePath).Replace('\\', '/');
                if (!sources.Contains(path) || treeByPath.ContainsKey(path)) continue;
                index.AddTree(tree, path, File.ReadAllBytes(tree.FilePath));
                treeByPath[path] = tree;
                trees.Add(tree);
            }
            var dir = System.IO.Path.GetDirectoryName(rel)!.Replace('\\', '/');
            result.Add(new LoadedProject(project.AssemblyName, rel, dir, compilation, trees, StaticProject.Read(ws.Root, rel, ws.ConfigText), restoreFailed));
        }
        return result;
    }
}
