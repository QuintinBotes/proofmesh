using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// Framework rules that ship with the adapter. Each matches types by namespace and name, so it fires on any repository that uses the framework and stays silent otherwise.
/// A fact a rule cannot complete stays unresolved on the code symbol the rule could name, with its reason.
/// </summary>
public static class Frameworks
{
    public static IEnumerable<IExtractor> BuiltIn(System.Text.Json.Nodes.JsonNode? conventions = null) =>
        [new EntityFramework(), new DependencyInjection(), new AspNetCore(), new RefitClients(), new MediatR(), new HostedServices(), new Configuration(), new Kafka(), new PulumiResources(), new HttpClientNames(), .. conventions is null ? [] : new IExtractor[] { new Conventions(conventions) }];

    internal static string Namespace(ISymbol symbol) => symbol.ContainingNamespace?.ToDisplayString() ?? "";
    internal static bool InNamespace(ISymbol symbol, string ns) => Namespace(symbol) is var s && (s == ns || s.StartsWith(ns + ".", StringComparison.Ordinal));
    internal static bool IsType(ITypeSymbol? type, string ns, string name) => type is not null && type.OriginalDefinition.Name == name && Namespace(type) == ns;

    internal static IEnumerable<ITypeSymbol> BaseTypes(ITypeSymbol? type)
    {
        for (var t = type; t is not null; t = t.BaseType) yield return t;
    }

    /// <summary>The type, its base classes, and every interface it implements.</summary>
    internal static IEnumerable<ITypeSymbol> Supertypes(ITypeSymbol type) => BaseTypes(type).Concat(type.AllInterfaces);

    internal static string? Text(SemanticModel model, SyntaxNode? expression) => expression is null ? null : model.GetConstantValue(expression).Value as string;

    internal static string InvocationName(InvocationExpressionSyntax invocation) => invocation.Expression switch
    {
        MemberAccessExpressionSyntax access => access.Name.Identifier.Text,
        MemberBindingExpressionSyntax binding => binding.Name.Identifier.Text,
        SimpleNameSyntax name => name.Identifier.Text,
        _ => "",
    };

    /// <summary>The expression a local variable was initialized with, followed through locals, else the expression itself.</summary>
    // shortcut: a local reassigned after its declaration keeps its initializer; track assignments if rules start to misread such locals.
    internal static ExpressionSyntax Origin(SemanticModel model, ExpressionSyntax expression) =>
        model.GetSymbolInfo(expression).Symbol is ILocalSymbol { DeclaringSyntaxReferences: [var reference] } && reference.GetSyntax() is VariableDeclaratorSyntax { Initializer.Value: var value }
            ? Origin(model, value)
            : expression;

    /// <summary>An HTTP endpoint's qualified name: its verb and its path without leading or trailing slashes, as in <c>GET api/orders/{id}</c>.</summary>
    internal static string Endpoint(string verb, string path) => $"{verb} {(path.TrimStart('~').Trim('/') is { Length: > 0 } p ? p : "/")}";

    /// <summary>Relationship detail naming the construct that established the fact and, for an unresolved one, why it stays open.</summary>
    internal static Dictionary<string, string> Rule(string rule, string? why = null) =>
        why is null ? new() { ["rule"] = rule } : new() { ["rule"] = rule, ["why"] = why };
}
