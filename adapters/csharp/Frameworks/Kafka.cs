using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// Confluent.Kafka: Produce and ProduceAsync on IProducer publish to their topic, and Subscribe on IConsumer consumes it. A topic is a
/// channel named <c>kafka:&lt;topic&gt;</c>; a topic that is not a constant string stays unresolved on the caller.
/// </summary>
public sealed class Kafka : IExtractor
{
    public string Id => "kafka";

    private static readonly Dictionary<string, (string Client, string Relationship)> Calls = new()
    {
        ["Produce"] = ("IProducer", "publishes"), ["ProduceAsync"] = ("IProducer", "publishes"), ["Subscribe"] = ("IConsumer", "consumes"),
    };

    public void Extract(ExtractionContext context)
    {
        foreach (var tree in context.Trees)
        {
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            foreach (var invocation in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (!Calls.TryGetValue(InvocationName(invocation), out var call) || model.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method
                    || !IsType(method.ContainingType, "Confluent.Kafka", call.Client) || context.OwnerOf(invocation) is not { } caller) continue;
                if (Text(model, invocation.ArgumentList.Arguments.FirstOrDefault()?.Expression) is { } topic)
                    context.Relate(call.Relationship, caller, invocation, context.Declare("channel", $"kafka:{topic}", invocation, topic), Rule(method.Name));
                else
                    context.Unresolved(call.Relationship, caller, invocation, "outside_capability", Rule(method.Name, "the topic is not a compile-time constant string"));
            }
        }
    }
}
