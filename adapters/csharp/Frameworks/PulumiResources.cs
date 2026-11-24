using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// Pulumi resources in a .NET program (A8, A25), named as the TypeScript rule names them: each <c>new T("name", args, options)</c> whose
/// type derives from Pulumi's CustomResource or ComponentResource is a <c>resource</c> symbol, its type a provider token such as
/// <c>aws.s3.Bucket</c> for a type in <c>Pulumi.Aws.S3</c>, else the class name. A resource references each resource whose outputs its
/// arguments read, and depends on each its options' <c>DependsOn</c> names, when a local holds that resource.
/// </summary>
public sealed class PulumiResources : IExtractor
{
    public string Id => "pulumi";

    public void Extract(ExtractionContext context)
    {
        foreach (var tree in context.Trees)
        {
            if (context.PathOf(tree) is not { } path) continue;
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            var resources = new Dictionary<SyntaxNode, string>();
            foreach (var creation in tree.GetRoot().DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
            {
                if (creation.ArgumentList?.Arguments is not [var first, ..] || model.GetTypeInfo(creation).Type is not INamedTypeSymbol type
                    || !BaseTypes(type).Any(t => IsType(t, "Pulumi", "CustomResource") || IsType(t, "Pulumi", "ComponentResource"))) continue;
                var ns = Namespace(type);
                var token = ns.StartsWith("Pulumi.", StringComparison.Ordinal) ? $"{ns["Pulumi.".Length..].ToLowerInvariant()}.{type.Name}" : type.Name;
                var name = Text(model, first.Expression) ?? (first.Expression is InterpolatedStringExpressionSyntax s ? string.Concat(s.Contents.Select(c => c.ToString())) : first.Expression.ToString());
                var range = context.RangeOf(creation);
                var id = $"{path}#resource#{token}::{name}#{range.StartByte}";
                context.AddSymbol(new FactSymbol(id, path, "resource", name, $"{Path.ChangeExtension(path, null)}:{token}::{name}", range, $"resource \"{token}\""));
                resources[creation] = id;
            }
            foreach (var (creation, source) in resources)
                foreach (var argument in ((BaseObjectCreationExpressionSyntax)creation).ArgumentList!.Arguments.Skip(1))
                {
                    if (!IsOptions(model.GetTypeInfo(argument.Expression).Type)) Relate(argument.Expression, "references");
                    else foreach (var dependsOn in argument.Expression.DescendantNodes().OfType<AssignmentExpressionSyntax>().Where(a => a.Left is IdentifierNameSyntax { Identifier.ValueText: "DependsOn" }))
                        Relate(dependsOn.Right, "depends_on");

                    void Relate(SyntaxNode scope, string relationship)
                    {
                        foreach (var reference in scope.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
                        {
                            if (model.GetSymbolInfo(reference).Symbol is not ILocalSymbol { DeclaringSyntaxReferences: [var declared] }
                                || declared.GetSyntax() is not VariableDeclaratorSyntax { Initializer.Value: { } value } || !resources.TryGetValue(value, out var target) || target == source) continue;
                            // The site is the output read, such as `logs.Arn`, short of a method called on it.
                            SyntaxNode site = reference;
                            while (site.Parent is MemberAccessExpressionSyntax access && access.Expression == site && !(access.Parent is InvocationExpressionSyntax call && call.Expression == access)) site = access;
                            context.Relate(relationship, source, site, target);
                        }
                    }
                }
        }
    }

    private static bool IsOptions(ITypeSymbol? type) => BaseTypes(type).Any(t => IsType(t, "Pulumi", "ResourceOptions"));
}
