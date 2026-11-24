using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// Microsoft.Extensions.DependencyInjection registrations: Add and TryAdd with a Scoped, Transient or Singleton lifetime in generic, typeof,
/// instance and factory forms, and typed HttpClients. Each links its implementation to its service. The implementation of an instance or
/// factory registration is the static type of the instance or of what the factory returns, when that is a concrete class; otherwise the
/// registration stays unresolved on its service. A constructor parameter of an implementation the container constructs whose type is a
/// registered service, in any project, is an injection.
/// </summary>
public sealed class DependencyInjection : IExtractor
{
    public string Id => "dependency_injection";

    private static readonly Dictionary<string, string> Lifetimes = new()
    {
        ["AddScoped"] = "Scoped", ["TryAddScoped"] = "Scoped",
        ["AddTransient"] = "Transient", ["TryAddTransient"] = "Transient",
        ["AddSingleton"] = "Singleton", ["TryAddSingleton"] = "Singleton",
        ["AddHttpClient"] = "Transient",
    };

    private ServiceRegistry? registry;

    public void Extract(ExtractionContext context)
    {
        // Every rule shares one registry, so it is held even when only an extension registers services.
        registry ??= context.Registry;
        foreach (var tree in context.Trees)
        {
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            foreach (var invocation in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
                if (Lifetimes.TryGetValue(InvocationName(invocation), out var lifetime)
                    && model.GetOperation(invocation) is IInvocationOperation { TargetMethod: var method } operation && InNamespace(method, "Microsoft.Extensions.DependencyInjection"))
                    Register(context, model, invocation, operation, lifetime);
        }
    }

    private void Register(ExtractionContext context, SemanticModel model, InvocationExpressionSyntax site, IInvocationOperation operation, string lifetime)
    {
        var method = operation.TargetMethod;
        var types = new List<ITypeSymbol?>(method.TypeArguments);
        ExpressionSyntax? supplied = null;
        foreach (var argument in operation.Arguments)
        {
            if (argument is not { ArgumentKind: ArgumentKind.Explicit, Parameter: { } parameter, Syntax: ArgumentSyntax { Expression: var expression } } || (method.IsExtensionMethod && parameter.Ordinal == 0)) continue;
            if (expression is TypeOfExpressionSyntax typeOf) types.Add(model.GetTypeInfo(typeOf.Type).Type);
            else if (IsType(parameter.Type, "System", "Type")) types.Add(null);
            // AddHttpClient's other arguments configure the client; they never supply it.
            else if (method.Name != "AddHttpClient") supplied ??= expression;
        }
        if (types.FirstOrDefault() is not { } service || context.LocalIdOf(service) is not { } serviceId) return;
        context.RegisterService(serviceId);
        var implementation = types.Count > 1 ? types[1] : supplied is null ? service : Supplied(model, supplied);
        if (implementation is null)
        {
            context.Unresolved("registered_as", serviceId, site, "outside_capability", Detail(method.Name, lifetime, "the instance or factory has no concrete class type"));
            return;
        }
        if (implementation is not INamedTypeSymbol type || context.LocalIdOf(type) is not { } implementationId) return;
        // The container calls only the constructors of the types it activates; an instance or factory builds its own.
        if (supplied is null) context.RegisterService(serviceId, type);
        context.Relate("registered_as", implementationId, site, serviceId, Detail(method.Name, lifetime));
    }

    public void Finish()
    {
        if (registry is null) return;
        foreach (var (id, (context, type)) in registry.Constructed)
            foreach (var constructor in type.InstanceConstructors.Where(c => !c.IsImplicitlyDeclared))
                foreach (var parameter in constructor.Parameters)
                    if (context.LocalIdOf(parameter.Type) is { } service && registry.Services.Contains(service) && parameter.DeclaringSyntaxReferences is [var syntax, ..])
                        context.Relate("injects", id, syntax.GetSyntax(), service, Rule("constructor"));
    }

    /// <summary>The concrete class an instance argument has, or that every return of a factory lambda has; else null.</summary>
    private static INamedTypeSymbol? Supplied(SemanticModel model, ExpressionSyntax expression)
    {
        List<ExpressionSyntax?> results = expression switch
        {
            AnonymousFunctionExpressionSyntax { ExpressionBody: { } body } => [body],
            AnonymousFunctionExpressionSyntax { Block: { } block } => block.DescendantNodes(n => n is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
                .OfType<ReturnStatementSyntax>().Select(r => r.Expression).ToList(),
            _ => [expression],
        };
        var types = results.Select(r => r is null ? null : model.GetTypeInfo(r).Type).Distinct(SymbolEqualityComparer.Default).ToList();
        return types is [INamedTypeSymbol { TypeKind: TypeKind.Class, IsAbstract: false } type] ? type : null;
    }

    private static Dictionary<string, string> Detail(string rule, string lifetime, string? why = null)
    {
        var detail = Rule(rule, why);
        detail["lifetime"] = lifetime;
        return detail;
    }
}
