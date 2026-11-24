using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// Named HTTP clients: <c>AddHttpClient("orders-service", ...)</c> and its typed forms register a client under a name that usually names
/// the service it calls. Each distinct name is a <c>service</c> symbol declared at its first registration, and the method that registers
/// it, or the file for top-level code, calls that service. A name that is not a compile-time constant stays unresolved on that code.
/// </summary>
public sealed class HttpClientNames : IExtractor
{
    public string Id => "http_client_name";

    public void Extract(ExtractionContext context)
    {
        foreach (var tree in context.Trees)
        {
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            foreach (var invocation in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (InvocationName(invocation) != "AddHttpClient" || model.GetOperation(invocation) is not IInvocationOperation operation
                    || !IsType(operation.TargetMethod.ContainingType, "Microsoft.Extensions.DependencyInjection", "HttpClientFactoryServiceCollectionExtensions")
                    || operation.Arguments.FirstOrDefault(a => a.Parameter is { Name: "name", Type.SpecialType: SpecialType.System_String })?.Syntax is not ArgumentSyntax { Expression: var expression }
                    || context.OwnerOf(invocation) is not { } caller) continue;
                if (Text(model, expression) is { } name) context.Relate("calls_service", caller, invocation, context.Declare("service", name, invocation), Rule("http_client_name"));
                else context.Unresolved("calls_service", caller, invocation, "outside_capability", Rule("http_client_name", "the client name is not a compile-time constant"));
            }
        }
    }
}
