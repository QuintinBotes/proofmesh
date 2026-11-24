using System.Reflection;
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;

namespace Proofmesh.Adapter.CSharp;

/// <summary>Information about one project, for extractors.</summary>
public sealed record ProjectFacts(string Name, string ProjectPath, string Directory);

/// <summary>An extension adds framework facts for one compilation. It must never run repository code.</summary>
public interface IExtractor
{
    string Id { get; }
    void Extract(ExtractionContext context);
    /// <summary>Called once after every project was extracted, for rules whose answer depends on several projects.</summary>
    void Finish() { }
}

/// <summary>Dependency-injection registrations every rule shares, so constructor injection covers types any rule registers.</summary>
public sealed class ServiceRegistry
{
    internal HashSet<string> Services { get; } = new(StringComparer.Ordinal);
    internal Dictionary<string, (ExtractionContext Context, INamedTypeSymbol Type)> Constructed { get; } = new(StringComparer.Ordinal);
}

/// <summary>Request handlers and the calls that hand requests to them, which every rule shares, so a house dispatcher reaches the handlers the built-in mediator rule finds.</summary>
public sealed class DispatchRegistry
{
    internal Dictionary<string, List<string>> Handlers { get; } = new(StringComparer.Ordinal);
    internal List<(ExtractionContext Context, string Caller, SyntaxNode Site, string Request, string Rule)> Dispatches { get; } = [];
}

public sealed class ExtractionContext(Compilation compilation, ProjectFacts project, IReadOnlyList<SyntaxTree> trees, DeclarationIndex index, Action<FactSymbol> addSymbol, Action<FactRelationship> addRelationship, HashSet<string> declared, ServiceRegistry registry, DispatchRegistry dispatches)
{
    internal ServiceRegistry Registry => registry;
    internal DispatchRegistry Dispatches => dispatches;

    /// <summary>
    /// Records a call that hands a request to its handlers, by the request's static type. Call it during Extract; in Finish the built-in
    /// mediator rule relates the caller to every handler of exactly that type, or leaves the dispatch unresolved with its reason.
    /// </summary>
    public void Dispatch(string caller, SyntaxNode site, ITypeSymbol? request, string rule)
    {
        if (request is not INamedTypeSymbol { TypeKind: TypeKind.Class or TypeKind.Struct } type)
            Unresolved("dispatches_to", caller, site, "outside_capability", Frameworks.Rule(rule, "the request type is not statically known"));
        else if (LocalIdOf(type) is { } requestId) dispatches.Dispatches.Add((this, caller, site, requestId, rule));
        else Unresolved("dispatches_to", caller, site, "outside_capability", Frameworks.Rule(rule, "no handler of the request type is declared in the repository"));
    }

    /// <summary>
    /// Records a dependency-injection registration so the built-in rule finds constructor injections: the service, and the implementation
    /// when the container constructs it (not an instance or a factory). Call it during Extract; constructor injection is settled in Finish.
    /// </summary>
    public void RegisterService(string serviceId, INamedTypeSymbol? constructedImplementation = null)
    {
        registry.Services.Add(serviceId);
        if (constructedImplementation is not null && LocalIdOf(constructedImplementation) is { } id) registry.Constructed.TryAdd(id, (this, constructedImplementation));
    }

    public Compilation Compilation { get; } = compilation;
    public ProjectFacts Project { get; } = project;
    public IReadOnlyList<SyntaxTree> Trees { get; } = trees;
    /// <summary>The local ID of a symbol declared in an indexed file, else null.</summary>
    public string? LocalIdOf(ISymbol symbol) => index.LocalIdOf(symbol);
    public string? PathOf(SyntaxTree tree) => index.PathOf(tree);
    /// <summary>The local ID of the declaration that contains a node, or of its file's module for top-level code: the owner calls use.</summary>
    public string? OwnerOf(SyntaxNode node) => index.OwnerOf(node) ?? (PathOf(node.SyntaxTree) is { } path ? index.ModuleOf(path) : null);
    public FactRange RangeOf(SyntaxNode node) => index.RangeOf(node.SyntaxTree, node.Span);
    public FactRange RangeOf(Location location) => index.RangeOf(location.SourceTree!, location.SourceSpan);
    public void AddSymbol(FactSymbol symbol) => addSymbol(symbol);
    public void AddRelationship(FactRelationship relationship) => addRelationship(relationship);

    /// <summary>
    /// Declares a framework symbol (endpoint, table, message, channel, job, feature_flag, config_key, team, service) once per kind and
    /// qualified name across the whole run; the first declaring site is its evidence. Returns its local ID.
    /// </summary>
    public string Declare(string kind, string qualifiedName, SyntaxNode at, string? name = null, string? signature = null)
    {
        var id = $"fw#{kind}#{qualifiedName}";
        if (declared.Add(id)) addSymbol(new FactSymbol(id, PathOf(at.SyntaxTree)!, kind, name ?? qualifiedName, qualifiedName, RangeOf(at), signature));
        return id;
    }

    /// <summary>A resolved framework relationship between two local symbols, citing the syntax that establishes it.</summary>
    public void Relate(string type, string source, SyntaxNode site, string target, IReadOnlyDictionary<string, string>? detail = null) =>
        addRelationship(new FactRelationship(type, "framework_adapter", FactRef.Sym(source), Site(site), "resolved", FactRef.Sym(target), Detail: detail));

    /// <summary>A framework relationship whose target the rules cannot determine statically, with its reason.</summary>
    public void Unresolved(string type, string source, SyntaxNode site, string reason, IReadOnlyDictionary<string, string>? detail = null) =>
        addRelationship(new FactRelationship(type, "framework_adapter", FactRef.Sym(source), Site(site), "unresolved", Reason: reason, Detail: detail));

    private FactSite Site(SyntaxNode node) => new(PathOf(node.SyntaxTree)!, RangeOf(node));
}

internal static class ExtensionLoader
{
    /// <summary>Loads IExtractor implementations from the assemblies the repository configuration names. Installing one is trusting its code.</summary>
    public static IReadOnlyList<IExtractor> Load(IEnumerable<string> paths, List<Diagnostic> diagnostics)
    {
        var extractors = new List<IExtractor>();
        foreach (var path in paths)
        {
            try
            {
                var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.GetFullPath(path));
                foreach (var type in assembly.GetTypes().Where(t => typeof(IExtractor).IsAssignableFrom(t) && t is { IsAbstract: false, IsInterface: false }))
                    extractors.Add((IExtractor)Activator.CreateInstance(type)!);
            }
            catch (Exception ex) when (ex is IOException or BadImageFormatException or ReflectionTypeLoadException or MissingMethodException)
            {
                diagnostics.Add(new Diagnostic("error", $"extension {path} failed to load: {ex.Message}"));
            }
        }
        return extractors;
    }
}
