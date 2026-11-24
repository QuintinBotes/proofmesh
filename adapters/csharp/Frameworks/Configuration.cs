using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// Microsoft.Extensions.Configuration reads: GetSection, GetRequiredSection, GetValue, the indexer and GetConnectionString, read by the
/// code that calls them, and options bound with services.Configure&lt;TOptions&gt;(section), read by the options class. A key read
/// through a section includes the section's path, as in <c>Payments:ApiKey</c>; a value typed IConfiguration is taken as the root.
/// A key or section path that is not a constant stays unresolved. Values are never read.
/// </summary>
public sealed class Configuration : IExtractor
{
    public string Id => "configuration";

    private const string Config = "Microsoft.Extensions.Configuration";

    private static readonly HashSet<string> Reads = ["GetSection", "GetRequiredSection", "GetValue", "GetConnectionString"];

    /// <summary>A read: the construct and the full key, null when not a constant.</summary>
    private sealed record Key(string Rule, string? Path);

    public void Extract(ExtractionContext context)
    {
        foreach (var tree in context.Trees)
        {
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                switch (node)
                {
                    case InvocationExpressionSyntax invocation when InvocationName(invocation) == "Configure":
                        Configure(context, model, invocation);
                        break;
                    case InvocationExpressionSyntax invocation when Reads.Contains(InvocationName(invocation)) && Read(model, invocation) is { } read:
                        Emit(context, read, invocation, context.OwnerOf(invocation));
                        break;
                    // An assignment writes the key.
                    case ElementAccessExpressionSyntax access when !(access.Parent is AssignmentExpressionSyntax assignment && assignment.Left == access) && Read(model, access) is { } read:
                        Emit(context, read, access, context.OwnerOf(access));
                        break;
                }
            }
        }
    }

    private static Key? Read(SemanticModel model, ExpressionSyntax node)
    {
        switch (model.GetOperation(node))
        {
            case IInvocationOperation { TargetMethod: var method } invocation when Namespace(method) == Config && Reads.Contains(method.Name):
            {
                var receiver = invocation.Instance ?? invocation.Arguments.FirstOrDefault(a => method.IsExtensionMethod && a.Parameter?.Ordinal == 0)?.Value;
                var key = Text(model, invocation.Arguments.FirstOrDefault(a => a.Parameter?.Name is "key" or "name")?.Value.Syntax);
                var section = Path(model, receiver?.Syntax);
                return new Key(method.Name, method.Name == "GetConnectionString" ? Join(Join(section, "ConnectionStrings"), key) : Join(section, key));
            }
            case IPropertyReferenceOperation { Property: { IsIndexer: true } indexer, Arguments: [var argument] } access when Namespace(indexer) == Config:
                return new Key("indexer", Join(Path(model, access.Instance?.Syntax), Text(model, argument.Value.Syntax)));
            default:
                return null;
        }
    }

    /// <summary>The section path a configuration value denotes: empty for the root, null when unknown.</summary>
    private static string? Path(SemanticModel model, SyntaxNode? syntax)
    {
        if (syntax is not ExpressionSyntax expression) return null;
        expression = Origin(model, expression);
        if (model.GetTypeInfo(expression).Type is not { } type || !Supertypes(type).Any(t => IsType(t, Config, "IConfigurationSection"))) return "";
        return expression is InvocationExpressionSyntax section && Read(model, section) is { Rule: "GetSection" or "GetRequiredSection", Path: var path } ? path : null;
    }

    private static string? Join(string? section, string? key) => section is null || key is null ? null : section.Length == 0 ? key : $"{section}:{key}";

    private static void Configure(ExtractionContext context, SemanticModel model, InvocationExpressionSyntax invocation)
    {
        if (model.GetOperation(invocation) is not IInvocationOperation { TargetMethod: { TypeArguments: [var options] } method } operation
            || !InNamespace(method, "Microsoft.Extensions.DependencyInjection") || context.LocalIdOf(options) is not { } optionsId
            || operation.Arguments.FirstOrDefault(a => a.Parameter?.Name == "config") is not { } config) return;
        // Options bound to the whole configuration name no key.
        if (Path(model, config.Value.Syntax) is var path && path == "") return;
        Emit(context, new Key("Configure", path), invocation, optionsId);
    }

    private static void Emit(ExtractionContext context, Key read, SyntaxNode site, string? reader)
    {
        if (reader is null) return;
        if (read.Path is null)
        {
            context.Unresolved("reads_config", reader, site, "outside_capability", Rule(read.Rule, "the key is not a compile-time constant"));
            return;
        }
        context.Relate("reads_config", reader, site, context.Declare("config_key", read.Path, site), Rule(read.Rule));
    }
}
