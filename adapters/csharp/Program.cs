using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Proofmesh.Adapter.CSharp;
using CapturedWorkspace = Proofmesh.Adapter.CSharp.CapturedWorkspace;

// Proofmesh C# adapter, protocol 0.2: JSON-RPC over stdio, one object per line. Reads only the captured workspace and reference assemblies on disk.
var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
var stdout = Console.OpenStandardOutput();
var sendLock = new object();
void Send(object message) { var bytes = JsonSerializer.SerializeToUtf8Bytes(message, json); lock (sendLock) { stdout.Write(bytes); stdout.WriteByte((byte)'\n'); stdout.Flush(); } }

// The core times out an adapter that stays silent. One step, such as binding a large project on a loaded machine, can take
// longer than that window, so while a request runs a timer repeats the latest progress every ten seconds. A crashed or
// deadlocked process stops writing and is still caught.
var current = new WorkState();
void Progress(string message) => current.Message = message;
using var heartbeat = new Timer(_ =>
{
    if (current.Busy) Send(new { jsonrpc = "2.0", method = "log", @params = new { level = "debug", message = $"working: {current.Message}" } });
}, null, 10000, 10000);

const string AdapterVersion = "0.1.0";
CapturedWorkspace? workspace = null;
string mode = "no_execution";
var extensionPaths = new List<string>();
JsonNode? conventions = null;
var index = new DeclarationIndex();
var treeByPath = new Dictionary<string, SyntaxTree>();
List<LoadedProject>? projects = null;
var pendingProjectFacts = new AnalyzeResult();
var loadDiagnostics = new List<Proofmesh.Adapter.CSharp.Diagnostic>();
var extensionFacts = new AnalyzeResult();
// Every package and reference pack the analysis read, listed in the manifest so the core hashes them into snapshot identity (A2).
var externalInputs = new SortedSet<string>(StringComparer.Ordinal);
string? roslynVersion = typeof(Compilation).Assembly.GetName().Version?.ToString();

async Task EnsureLoadedAsync()
{
    if (projects is not null) return;
    projects = mode == "trusted_build"
        ? await TrustedLoader.LoadAsync(workspace!, index, treeByPath, loadDiagnostics, Progress)
        : NoExecutionLoader.Load(workspace!, index, treeByPath, loadDiagnostics, Progress, externalInputs);
    foreach (var p in projects)
        foreach (var tree in p.Trees)
        {
            Progress($"indexing declarations in {p.Name}");
            index.IndexDeclarations(p.Compilation.GetSemanticModel(tree, ignoreAccessibility: true), tree);
        }
    Extractor.ProjectFacts(projects, workspace!, index, pendingProjectFacts);
    var extractors = Frameworks.BuiltIn(conventions).Concat(ExtensionLoader.Load(extensionPaths, loadDiagnostics)).ToList();
    var declared = new HashSet<string>(StringComparer.Ordinal);
    var registry = new ServiceRegistry();
    var dispatches = new DispatchRegistry();
    foreach (var p in projects)
        foreach (var x in extractors)
        {
            Progress($"framework rules {x.Id} in {p.Name}");
            try { x.Extract(new ExtractionContext(p.Compilation, new ProjectFacts(p.Name, p.ProjectPath, p.Directory), p.Trees, index, extensionFacts.Symbols.Add, extensionFacts.Relationships.Add, declared, registry, dispatches)); }
            catch (Exception ex) { loadDiagnostics.Add(new Proofmesh.Adapter.CSharp.Diagnostic("error", $"extension {x.Id} failed on {p.Name}: {ex.GetType().Name}: {ex.Message}")); }
        }
    foreach (var x in extractors)
    {
        try { x.Finish(); }
        catch (Exception ex) { loadDiagnostics.Add(new Proofmesh.Adapter.CSharp.Diagnostic("error", $"extension {x.Id} failed to finish: {ex.GetType().Name}: {ex.Message}")); }
    }
}

async Task<AnalyzeResult> AnalyzeAsync(IReadOnlyList<string> paths)
{
    await EnsureLoadedAsync();
    var result = new AnalyzeResult();
    var projectOf = projects!.SelectMany(p => p.Trees.Select(t => (t, p))).GroupBy(x => x.t).ToDictionary(g => g.Key, g => g.First().p);
    foreach (var path in paths)
    {
        if (!treeByPath.TryGetValue(path, out var tree) || !projectOf.TryGetValue(tree, out var project))
        {
            result.FileResults.Add(new FileResult(path, "failed", new Dictionary<string, string>(), "not_in_any_project"));
            continue;
        }
        Progress($"analyzing {path}");
        result.Symbols.AddRange(index.SymbolsByPath.GetValueOrDefault(path) ?? []);
        var facts = Extractor.Relationships(project.Compilation.GetSemanticModel(tree, ignoreAccessibility: true), tree, index, project.DependenciesMissing, project.MissingPackages);
        result.Relationships.AddRange(facts.Relationships);
        result.FileResults.Add(new FileResult(path, "ok", new Dictionary<string, string>
        {
            ["text"] = "complete", ["syntax"] = "complete", ["symbols"] = "complete", ["imports"] = "unsupported",
            ["references"] = "partial", ["resolved_calls"] = facts.Unresolved > 0 ? "partial" : "complete", ["framework"] = "partial",
        }));
    }
    return result;
}

/// <summary>Project structure and every framework rule: facts that read the whole workspace, so the core never caches them.</summary>
async Task<AnalyzeResult> WorkspaceAsync()
{
    await EnsureLoadedAsync();
    var result = new AnalyzeResult();
    result.Symbols.AddRange(pendingProjectFacts.Symbols); result.Relationships.AddRange(pendingProjectFacts.Relationships);
    result.Symbols.AddRange(extensionFacts.Symbols); result.Relationships.AddRange(extensionFacts.Relationships);
    result.Diagnostics.AddRange(loadDiagnostics);
    return result;
}

/// <summary>
/// One unit per project: a file's facts come from its project's compilation, which reads the project's files and those of every project
/// it references (the loader adds references transitively). Trusted builds load through MSBuild, where that mapping is not guaranteed.
/// </summary>
object[]? Units()
{
    // shortcut: trusted builds declare no units, so any change reanalyses every file; map MSBuild project references when that costs too much.
    if (mode == "trusted_build") return null;
    var unitOf = projects!.ToDictionary(p => p.Compilation, p => p.ProjectPath.Length > 0 ? p.ProjectPath : p.Name);
    return projects!.Select(p => (object)new
    {
        id = unitOf[p.Compilation],
        files = p.Trees.Select(index.PathOf).OfType<string>().Distinct().Order(StringComparer.Ordinal).ToArray(),
        depends_on = p.Compilation.References.OfType<CompilationReference>().Select(r => unitOf.GetValueOrDefault(r.Compilation)).OfType<string>().Distinct().Order(StringComparer.Ordinal).ToArray(),
    }).ToArray();
}

using var stdin = new StreamReader(Console.OpenStandardInput());
while (await stdin.ReadLineAsync() is { } line)
{
    JsonNode? req;
    try { req = JsonNode.Parse(line); } catch (JsonException) { continue; }
    var id = req?["id"]?.GetValue<int>();
    var method = req?["method"]?.GetValue<string>();
    current.Busy = true;
    try
    {
        switch (method)
        {
            case "initialize":
            {
                var p = req!["params"]!;
                mode = p["analysis_mode"]?.GetValue<string>() == "trusted_build" ? "trusted_build" : "no_execution";
                var files = p["files"]!.AsArray().Select(f => (Path: f!["path"]!.GetValue<string>(), Language: f["language"]!.GetValue<string>())).ToList();
                var root = p["workspace"]!.GetValue<string>();
                var configText = files.Where(f => f.Language == "csharp-config").ToDictionary(f => f.Path, f => File.ReadAllText(Path.Combine(root, f.Path)));
                workspace = new CapturedWorkspace(root, files.Where(f => f.Language == "csharp").Select(f => f.Path).ToList(), configText);
                extensionPaths = p["config"]?["extensions"]?.AsArray().Select(x => x!.GetValue<string>()).ToList() ?? [];
                conventions = p["config"]?["conventions"]?.DeepClone();
                var toolchain = new Dictionary<string, string> { ["roslyn"] = roslynVersion ?? "unknown", ["dotnet"] = Environment.Version.ToString() };
                if (Toolchain.PackDirectory("Microsoft.NETCore.App.Ref") is { } core) toolchain["netcore_ref"] = Path.GetFileName(Path.GetDirectoryName(Path.GetDirectoryName(core))!)!;
                // The adapter's own build is part of snapshot identity, so changed rules never reuse a snapshot built by older ones.
                toolchain["adapter_build"] = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(typeof(DeclarationIndex).Assembly.Location)))[..16];
                // Loading here, not at the first analyze, lets the manifest list exactly the external inputs the analysis reads.
                await EnsureLoadedAsync();
                foreach (var pack in new[] { "Microsoft.NETCore.App.Ref", "Microsoft.AspNetCore.App.Ref" }) if (Toolchain.PackInput(pack) is { } input) externalInputs.Add(input);
                foreach (var ext in extensionPaths) toolchain[$"extension:{Path.GetFileName(ext)}"] = File.Exists(ext) ? Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(ext)))[..16] : "missing";
                Send(new { jsonrpc = "2.0", id, result = new
                {
                    adapter = new { id = "csharp", version = AdapterVersion, protocol_version = "1.1", languages = new[] { "csharp" }, toolchain },
                    capabilities = new Dictionary<string, bool> { ["syntax"] = true, ["symbols"] = true, ["imports"] = false, ["resolved_calls"] = true, ["references"] = true, ["framework"] = true },
                    external_inputs = externalInputs.ToArray(),
                    analysis_mode = mode,
                    units = Units(),
                } });
                break;
            }
            case "workspace":
                Send(new { jsonrpc = "2.0", id, result = await WorkspaceAsync() });
                break;
            case "analyze":
                Send(new { jsonrpc = "2.0", id, result = await AnalyzeAsync(req!["params"]!["paths"]!.AsArray().Select(x => x!.GetValue<string>()).ToList()) });
                break;
            case "shutdown":
                Send(new { jsonrpc = "2.0", id, result = new { } });
                return 0;
            default:
                Send(new { jsonrpc = "2.0", id, error = new { code = -32601, message = $"unknown method {method}" } });
                break;
        }
    }
    catch (Exception ex)
    {
        Send(new { jsonrpc = "2.0", id, error = new { code = -32603, message = $"{ex.GetType().Name}: {ex.Message}" } });
    }
    finally
    {
        current.Busy = false;
    }
}
return 0;

sealed class WorkState
{
    public volatile bool Busy;
    public volatile string Message = "starting";
}
