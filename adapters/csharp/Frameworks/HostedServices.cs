using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>Microsoft.Extensions.Hosting: a concrete class implementing IHostedService, directly or through BackgroundService, is a job the host runs.</summary>
public sealed class HostedServices : IExtractor
{
    public string Id => "hosted_services";

    private const string Hosting = "Microsoft.Extensions.Hosting";

    public void Extract(ExtractionContext context)
    {
        foreach (var tree in context.Trees)
        {
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            foreach (var declaration in tree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                if (declaration.BaseList is not { } list || model.GetDeclaredSymbol(declaration) is not { IsAbstract: false } type || context.LocalIdOf(type) is not { } typeId) continue;
                foreach (var baseType in list.Types)
                {
                    if (model.GetTypeInfo(baseType.Type).Type is not { } reached) continue;
                    var rule = BaseTypes(reached).Any(t => IsType(t, Hosting, "BackgroundService")) ? "BackgroundService"
                        : Supertypes(reached).Any(t => IsType(t, Hosting, "IHostedService")) ? "IHostedService"
                        : null;
                    if (rule is null) continue;
                    var job = context.Declare("job", DeclarationIndex.Qualified(type), baseType, type.Name);
                    context.Relate("runs", job, baseType, typeId, Rule(rule));
                    break;
                }
            }
        }
    }
}
