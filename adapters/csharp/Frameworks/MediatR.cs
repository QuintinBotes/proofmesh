using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// MediatR: a concrete class implementing IRequestHandler or INotificationHandler handles its request type. A Send or Publish call whose
/// request has a statically known class or struct type dispatches to every handler of exactly that type, in any project; a call whose
/// request type is not known, or that no handler in the repository handles, stays unresolved on the caller.
/// </summary>
public sealed class MediatR : IExtractor
{
    public string Id => "mediatr";

    private static readonly HashSet<string> HandlerInterfaces = ["IRequestHandler", "INotificationHandler"];
    private static readonly HashSet<string> Mediators = ["ISender", "IPublisher", "IMediator", "Mediator"];

    private DispatchRegistry? registry;

    public void Extract(ExtractionContext context)
    {
        registry ??= context.Dispatches;
        foreach (var tree in context.Trees)
        {
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                switch (node)
                {
                    case ClassDeclarationSyntax { BaseList: { } list } declaration when model.GetDeclaredSymbol(declaration) is { IsAbstract: false } type && context.LocalIdOf(type) is { } handlerId:
                        foreach (var baseType in list.Types)
                        {
                            if (model.GetTypeInfo(baseType.Type).Type is not { } reached) continue;
                            foreach (var handled in Supertypes(reached).OfType<INamedTypeSymbol>().Where(i => Namespace(i) == "MediatR" && HandlerInterfaces.Contains(i.Name)))
                            {
                                if (context.LocalIdOf(handled.TypeArguments[0]) is not { } requestId) continue;
                                context.Relate("handles", handlerId, baseType, requestId, Rule(handled.Name));
                                if (!registry.Handlers.TryGetValue(requestId, out var known)) registry.Handlers[requestId] = known = [];
                                known.Add(handlerId);
                            }
                        }
                        break;
                    case InvocationExpressionSyntax invocation when InvocationName(invocation) is "Send" or "Publish"
                        && model.GetSymbolInfo(invocation).Symbol is IMethodSymbol method && Namespace(method) == "MediatR" && Mediators.Contains(method.ContainingType.Name)
                        && context.OwnerOf(invocation) is { } caller:
                        context.Dispatch(caller, invocation, Request(model, invocation, method), method.Name);
                        break;
                }
            }
        }
    }

    /// <summary>Relates every dispatch any rule recorded, so house dispatchers and MediatR calls resolve against the same handlers.</summary>
    public void Finish()
    {
        if (registry is null) return;
        foreach (var d in registry.Dispatches)
        {
            if (registry.Handlers.TryGetValue(d.Request, out var found))
                foreach (var handler in found) d.Context.Relate("dispatches_to", d.Caller, d.Site, handler, Rule(d.Rule));
            else
                d.Context.Unresolved("dispatches_to", d.Caller, d.Site, "outside_capability", Rule(d.Rule, "no handler of the request type is declared in the repository"));
        }
    }

    /// <summary>The static type of the request or notification argument: the first one that is not a cancellation token.</summary>
    private static ITypeSymbol? Request(SemanticModel model, InvocationExpressionSyntax invocation, IMethodSymbol method)
    {
        if (method.Parameters.FirstOrDefault(p => !IsType(p.Type, "System.Threading", "CancellationToken")) is not { } parameter) return null;
        var arguments = invocation.ArgumentList.Arguments;
        var argument = arguments.FirstOrDefault(a => a.NameColon?.Name.Identifier.Text == parameter.Name)
            ?? (parameter.Ordinal < arguments.Count && arguments[parameter.Ordinal].NameColon is null ? arguments[parameter.Ordinal] : null);
        return argument is null ? null : model.GetTypeInfo(argument.Expression).Type;
    }
}
