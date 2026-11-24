using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// Refit outbound HTTP: an interface method with a Refit verb attribute dispatches to the endpoint its path names, without the query
/// string. The path is relative to the client's base address, which the rule does not read.
/// </summary>
public sealed class RefitClients : IExtractor
{
    public string Id => "refit";

    private static readonly Dictionary<string, string> Verbs = new()
    {
        ["GetAttribute"] = "GET", ["PostAttribute"] = "POST", ["PutAttribute"] = "PUT", ["DeleteAttribute"] = "DELETE",
        ["PatchAttribute"] = "PATCH", ["HeadAttribute"] = "HEAD", ["OptionsAttribute"] = "OPTIONS",
    };

    public void Extract(ExtractionContext context)
    {
        foreach (var tree in context.Trees)
        {
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            foreach (var declaration in tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>())
            {
                if (declaration is not { Parent: InterfaceDeclarationSyntax, AttributeLists.Count: > 0 } || model.GetDeclaredSymbol(declaration) is not { } method || context.LocalIdOf(method) is not { } methodId) continue;
                foreach (var attribute in method.GetAttributes())
                {
                    if (attribute is not { AttributeClass: { } type, ConstructorArguments: [{ Value: string path }, ..], ApplicationSyntaxReference: { } reference }
                        || Namespace(type) != "Refit" || !Verbs.TryGetValue(type.Name, out var verb)) continue;
                    var site = reference.GetSyntax();
                    var endpoint = context.Declare("endpoint", Endpoint(verb, path.Split('?')[0]), site);
                    context.Relate("dispatches_to", methodId, site, endpoint, new Dictionary<string, string> { ["direction"] = "outbound", ["rule"] = "refit" });
                }
            }
        }
    }
}
