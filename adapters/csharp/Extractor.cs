using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Proofmesh.Adapter.CSharp;

/// <summary>Calls, inheritance, overrides, and project structure, resolved with the semantic model.</summary>
public static class Extractor
{
    public sealed record FileFacts(List<FactRelationship> Relationships, int Unresolved);

    public static FileFacts Relationships(SemanticModel model, SyntaxTree tree, DeclarationIndex index, bool dependenciesMissing, IReadOnlyList<string>? missingPackages = null)
    {
        // An unbound name is blamed on a missing package only when this project actually lacks one, and the blame names every one of
        // them, so a count per package covers all of them.
        var unbound = dependenciesMissing ? "dependency_missing" : "unknown_name";
        var blame = dependenciesMissing && missingPackages is { Count: > 0 }
            ? new Dictionary<string, string> { ["packages"] = string.Join(", ", missingPackages) }
            : null;
        var path = index.PathOf(tree)!;
        var rels = new List<FactRelationship>();
        var references = new Dictionary<(string Owner, string Target), (FactSite Site, SortedSet<string> Uses, List<FactRange> More)>();
        var unresolved = 0;
        var root = tree.GetRoot();
        foreach (var node in root.DescendantNodes())
        {
            switch (node)
            {
                // nameof is an operator the compiler folds to a string, not a call; the names inside it are references.
                case InvocationExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.ValueText: "nameof" } } when model.GetOperation(node) is Microsoft.CodeAnalysis.Operations.INameOfOperation:
                    break;
                case InvocationExpressionSyntax or BaseObjectCreationExpressionSyntax:
                {
                    var owner = index.OwnerOf(node) ?? index.ModuleOf(path);
                    if (owner is null) continue;
                    var r = ResolveCall(model, (ExpressionSyntax)node, index, unbound);
                    if (r.Resolution == "resolved" && r.Target?.Symbol == owner) continue;
                    if (r.Resolution is not ("resolved" or "resolved_external")) unresolved++;
                    var detail = r.Resolution is "resolved" or "resolved_external" ? r.Detail : Unbound(model, (ExpressionSyntax)node, r.Reason == "dependency_missing" ? blame : r.Detail);
                    // A call that fails only because a name inside it does not bind is blamed on that name, not on the analysis.
                    var reason = r.Reason == "outside_capability" && detail is not null && detail.TryGetValue("compiler", out var compiler) && UnboundNameErrors.Any(compiler.StartsWith) ? unbound : r.Reason;
                    if (reason != r.Reason && reason == "dependency_missing" && blame is not null) foreach (var (k, v) in blame) detail![k] = v;
                    rels.Add(new FactRelationship("calls", "semantic_resolver", FactRef.Sym(owner), new FactSite(path, index.RangeOf(tree, node.Span)), r.Resolution, r.Target, reason, r.Candidates, Detail: detail));
                    break;
                }
                case SimpleNameSyntax name when References.Of(model, name, index) is { } reference:
                {
                    var owner = index.OwnerOf(name) ?? index.ModuleOf(path);
                    if (owner is null || owner == reference.Target) break;
                    var at = index.RangeOf(tree, reference.Site.Span);
                    if (references.TryGetValue((owner, reference.Target), out var seen)) { seen.Uses.Add(reference.Use); seen.More.Add(at); }
                    else references[(owner, reference.Target)] = (new FactSite(path, at), new SortedSet<string>(StringComparer.Ordinal) { reference.Use }, []);
                    break;
                }
                case BaseTypeDeclarationSyntax { BaseList: { } baseList } type when model.GetDeclaredSymbol(type) is INamedTypeSymbol declared && index.LocalIdOf(declared) is { } source:
                {
                    foreach (var bt in baseList.Types)
                    {
                        var t = model.GetTypeInfo(bt.Type).Type as INamedTypeSymbol;
                        var kind = t?.TypeKind == TypeKind.Interface || declared.TypeKind == TypeKind.Interface ? "implements" : "inherits";
                        var site = new FactSite(path, index.RangeOf(tree, bt.Span));
                        // A base type that does not bind keeps the name it is written with, which the gRPC server rule reads (FR403).
                        if (t is null || t.TypeKind == TypeKind.Error)
                        {
                            unresolved++;
                            var detail = new Dictionary<string, string> { ["name"] = bt.Type.ToString() };
                            if (unbound == "dependency_missing" && blame is not null) foreach (var (k, v) in blame) detail[k] = v;
                            rels.Add(new FactRelationship(kind, "semantic_resolver", FactRef.Sym(source), site, "unresolved", Reason: unbound, Detail: detail));
                            continue;
                        }
                        rels.Add(Link(kind, source, site, t, index));
                    }
                    break;
                }
                case MethodDeclarationSyntax or PropertyDeclarationSyntax when model.GetDeclaredSymbol(node) is { ContainingType.TypeKind: not TypeKind.Interface } declared && index.LocalIdOf(declared) is { } source:
                {
                    var member = (MemberDeclarationSyntax)node;
                    var overridden = (declared as IMethodSymbol)?.OverriddenMethod ?? (ISymbol?)(declared as IPropertySymbol)?.OverriddenProperty;
                    if (overridden is not null && member.Modifiers.Any(SyntaxKind.OverrideKeyword))
                        rels.Add(Link("overrides", source, new FactSite(path, index.RangeOf(tree, member.Modifiers.First(x => x.IsKind(SyntaxKind.OverrideKeyword)).Span)), overridden, index));
                    // Callers that go through an interface reach the implementation by dispatch, so the member records what it implements.
                    // shortcut: an implementation inherited from a base class that does not itself implement the interface is not linked.
                    var name = node is MethodDeclarationSyntax md ? md.Identifier : ((PropertyDeclarationSyntax)node).Identifier;
                    foreach (var contract in Implemented(declared))
                        rels.Add(Link("implements", source, new FactSite(path, index.RangeOf(tree, name.Span)), contract, index));
                    break;
                }
            }
        }
        // One reference per user and target, cited at its first site, with every way the user touches the target and every further site (protocol 1.3).
        foreach (var ((owner, target), (site, uses, more)) in references)
            rels.Add(new FactRelationship("references", "semantic_resolver", FactRef.Sym(owner), site, "resolved", FactRef.Sym(target), Detail: new Dictionary<string, string> { ["use"] = string.Join(",", uses) }, Sites: more.Count > 0 ? more : null));
        return new FileFacts(rels, unresolved);
    }

    /// <summary>
    /// What a call that does not bind still tells: the name it calls and its argument count, which find its likely targets by name,
    /// and the compiler's first error inside it, which says what to check by hand.
    /// </summary>
    /// <summary>Compiler errors that mean a name does not bind: an unknown type, name or namespace member, or a type in an assembly the analysis lacks.</summary>
    private static readonly string[] UnboundNameErrors = ["CS0246:", "CS0103:", "CS0234:", "CS0012:"];

    private static Dictionary<string, string> Unbound(SemanticModel model, ExpressionSyntax node, IReadOnlyDictionary<string, string>? known)
    {
        var detail = known is null ? new Dictionary<string, string>() : new Dictionary<string, string>(known);
        var callee = node switch
        {
            InvocationExpressionSyntax invocation => Frameworks.InvocationName(invocation),
            ObjectCreationExpressionSyntax { Type: var type } => type switch { SimpleNameSyntax s => s.Identifier.ValueText, QualifiedNameSyntax q => q.Right.Identifier.ValueText, _ => "" },
            _ => "",
        };
        if (callee.Length > 0) detail["callee"] = callee;
        var arguments = node switch { InvocationExpressionSyntax i => i.ArgumentList.Arguments.Count, BaseObjectCreationExpressionSyntax o => o.ArgumentList?.Arguments.Count ?? 0, _ => 0 };
        detail["arity"] = arguments.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (model.GetDiagnostics(node.Span).FirstOrDefault(d => d.Severity == DiagnosticSeverity.Error) is { } error)
        {
            var message = error.GetMessage(System.Globalization.CultureInfo.InvariantCulture);
            detail["compiler"] = $"{error.Id}: {(message.Length > 200 ? message[..200] + "…" : message)}";
        }
        return detail;
    }

    private static IEnumerable<ISymbol> Implemented(ISymbol member)
    {
        var explicitly = member switch { IMethodSymbol m => m.ExplicitInterfaceImplementations.CastArray<ISymbol>(), IPropertySymbol p => p.ExplicitInterfaceImplementations.CastArray<ISymbol>(), _ => [] };
        if (!explicitly.IsEmpty) return explicitly;
        var type = member.ContainingType;
        return type.AllInterfaces.SelectMany(i => i.GetMembers(member.Name)).Where(c => SymbolEqualityComparer.Default.Equals(type.FindImplementationForInterfaceMember(c), member));
    }

    private static FactRelationship Link(string type, string source, FactSite site, ISymbol target, DeclarationIndex index) =>
        index.LocalIdOf(target) is { } local
            ? new FactRelationship(type, "semantic_resolver", FactRef.Sym(source), site, "resolved", FactRef.Sym(local))
            : new FactRelationship(type, "semantic_resolver", FactRef.Sym(source), site, "resolved_external", External(target));

    private sealed record Resolved(string Resolution, FactRef? Target = null, string? Reason = null, IReadOnlyList<string>? Candidates = null, Dictionary<string, string>? Detail = null);

    private static FactRef External(ISymbol s)
    {
        var module = s.ContainingAssembly?.Name ?? (s.Locations.Any(l => l.IsInSource) ? "generated" : "unknown");
        var name = s is INamedTypeSymbol t ? t.ToDisplayString() : $"{s.ContainingType?.ToDisplayString() ?? s.ContainingNamespace?.ToDisplayString()}.{(s is IMethodSymbol { MethodKind: MethodKind.Constructor } ? ".ctor" : s.Name)}";
        return FactRef.Ext(module, name);
    }

    private static Resolved ResolveCall(SemanticModel model, ExpressionSyntax node, DeclarationIndex index, string unbound)
    {
        var info = model.GetSymbolInfo(node);
        if (info.Symbol is { } sym)
            return index.LocalIdOf(sym) is { } local ? new Resolved("resolved", FactRef.Sym(local)) : new Resolved("resolved_external", External(sym));
        var candidates = info.CandidateSymbols.Select(index.LocalIdOf).OfType<string>().Distinct().Order(StringComparer.Ordinal).ToList();
        var why = new Dictionary<string, string> { ["why"] = $"the call does not bind: {info.CandidateReason}" };
        if (candidates.Count == 1 && info.CandidateSymbols.Length == 1) return new Resolved("candidate", Reason: "outside_capability", Candidates: candidates, Detail: why);
        if (candidates.Count > 1) return new Resolved("ambiguous", Reason: "outside_capability", Candidates: candidates, Detail: why);
        var reason = Classify(model, node, unbound, info.CandidateReason);
        return new Resolved("unresolved", Reason: reason, Detail: reason == "outside_capability" && info.CandidateReason != CandidateReason.None ? new Dictionary<string, string> { ["why"] = $"the call does not bind: {info.CandidateReason}" } : null);
    }

    /// <summary>Why a call has no target, in the taxonomy of amendment A3.</summary>
    private static string Classify(SemanticModel model, ExpressionSyntax node, string unbound, CandidateReason candidateReason = CandidateReason.None)
    {
        var callee = node is InvocationExpressionSyntax inv ? inv.Expression : (node as ObjectCreationExpressionSyntax)?.Type;
        switch (callee)
        {
            case ElementAccessExpressionSyntax: return "dynamic_element_access";
            case MemberAccessExpressionSyntax access:
            {
                var receiver = model.GetTypeInfo(access.Expression).Type;
                if (receiver is { TypeKind: TypeKind.Dynamic }) return "untyped_receiver";
                if (receiver is null || receiver.TypeKind == TypeKind.Error) return access.Expression is InvocationExpressionSyntax ? "chained_callee" : unbound;
                // A member the known receiver type does not have, such as an extension method from a package that is not in the
                // cache (expression-tree helpers like Invoke or Expand), is an unknown name; a member that exists but does not bind is outside capability.
                return candidateReason == CandidateReason.None ? unbound : "outside_capability";
            }
            case null: return "outside_capability";
            default:
            {
                var t = model.GetTypeInfo(callee).Type;
                if (t is { TypeKind: TypeKind.Error }) return unbound;
                return callee is IdentifierNameSyntax or GenericNameSyntax ? "unknown_name" : "outside_capability";
            }
        }
    }

    private static readonly Regex ProjectReferenceRx = new("<ProjectReference\\s+Include=\"([^\"]+)\"[^>]*>", RegexOptions.CultureInvariant);
    private static readonly Regex PackageReferenceRx = new("<PackageReference\\s+Include=\"([^\"]+)\"[^>]*>", RegexOptions.CultureInvariant);
    private static readonly Regex ProjectRootRx = new("<Project[\\s>]", RegexOptions.CultureInvariant);

    /// <summary>Project symbols and their structure, with evidence in the project files.</summary>
    public static void ProjectFacts(IReadOnlyList<LoadedProject> projects, CapturedWorkspace ws, DeclarationIndex index, AnalyzeResult result)
    {
        var idByPath = new Dictionary<string, string>();
        foreach (var p in projects.Where(p => p.Static is not null))
        {
            var text = ws.ConfigText[p.ProjectPath];
            var bytes = File.ReadAllBytes(Path.Combine(ws.Root, p.ProjectPath));
            var at = StaticProject.Locate(text, bytes, ProjectRootRx);
            if (at is null) continue;
            var range = new FactRange(at.Value.Start, at.Value.End, at.Value.StartLine, at.Value.EndLine);
            var id = $"project:{p.ProjectPath}";
            idByPath[p.ProjectPath] = id;
            result.Symbols.Add(new FactSymbol(id, p.ProjectPath, "project", p.Name, p.Name, range, null));
            foreach (var tree in p.Trees)
                if (index.ModuleOf(index.PathOf(tree)!) is { } module)
                    result.Relationships.Add(new FactRelationship("contains", "configuration_adapter", FactRef.Sym(id), new FactSite(p.ProjectPath, range), "resolved", FactRef.Sym(module)));
        }
        foreach (var p in projects.Where(p => p.Static is not null && idByPath.ContainsKey(p.ProjectPath)))
        {
            var text = ws.ConfigText[p.ProjectPath];
            var bytes = File.ReadAllBytes(Path.Combine(ws.Root, p.ProjectPath));
            var source = idByPath[p.ProjectPath];
            for (var i = 0; i < p.Static!.ProjectReferences.Count; i++)
            {
                var at = StaticProject.Locate(text, bytes, ProjectReferenceRx, i);
                if (at is null) continue;
                var site = new FactSite(p.ProjectPath, new FactRange(at.Value.Start, at.Value.End, at.Value.StartLine, at.Value.EndLine));
                var target = p.Static.ProjectReferences[i];
                result.Relationships.Add(idByPath.TryGetValue(target, out var dep)
                    ? new FactRelationship("depends_on", "configuration_adapter", FactRef.Sym(source), site, "resolved", FactRef.Sym(dep))
                    : new FactRelationship("depends_on", "configuration_adapter", FactRef.Sym(source), site, "unresolved", Reason: "import_unresolved"));
            }
            for (var i = 0; i < p.Static.PackageReferences.Count; i++)
            {
                var at = StaticProject.Locate(text, bytes, PackageReferenceRx, i);
                if (at is null) continue;
                var (pkg, version) = p.Static.PackageReferences[i];
                var site = new FactSite(p.ProjectPath, new FactRange(at.Value.Start, at.Value.End, at.Value.StartLine, at.Value.EndLine));
                var detail = version is null ? null : new Dictionary<string, string> { ["version"] = version };
                result.Relationships.Add(new FactRelationship("depends_on_package", "configuration_adapter", FactRef.Sym(source), site, "resolved_external", FactRef.Ext("nuget", pkg), Detail: detail));
            }
            // A package a Directory.Build.props file adds is cited where that file adds it.
            foreach (var (pkg, version, props) in p.Static.InheritedPackageReferences)
            {
                if (!ws.ConfigText.TryGetValue(props, out var propsText)) continue;
                var at = StaticProject.Locate(propsText, File.ReadAllBytes(Path.Combine(ws.Root, props)), new Regex($"<PackageReference\\s+Include=\"{Regex.Escape(pkg)}\"[^>]*>", RegexOptions.CultureInvariant));
                if (at is null) continue;
                var site = new FactSite(props, new FactRange(at.Value.Start, at.Value.End, at.Value.StartLine, at.Value.EndLine));
                var detail = version is null ? null : new Dictionary<string, string> { ["version"] = version };
                result.Relationships.Add(new FactRelationship("depends_on_package", "configuration_adapter", FactRef.Sym(source), site, "resolved_external", FactRef.Ext("nuget", pkg), Detail: detail));
            }
        }
    }
}
