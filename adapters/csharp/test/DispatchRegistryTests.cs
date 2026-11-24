using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Proofmesh.Adapter.CSharp.Tests;

public class DispatchRegistryTests
{
    private const string Source = """
        namespace MediatR
        {
            public interface IRequest<TResponse> { }
            public interface IRequestHandler<TRequest, TResponse> where TRequest : IRequest<TResponse> { }
        }
        namespace App
        {
            using MediatR;

            public class GetClock : IRequest<int> { }
            public class GetClockHandler : IRequestHandler<GetClock, int> { }
            public static class House
            {
                public static int Execute<T>(IRequest<T> request) => 0;
            }
            public static class Caller
            {
                public static int Known() => House.Execute(new GetClock());
                public static int Unknown(IRequest<int> request) => House.Execute(request);
            }
        }
        """;

    /// <summary>A rules extension for a house dispatcher: it reports each Execute call with the request's static type, as an overlay would.</summary>
    private sealed class HouseDispatcher : IExtractor
    {
        public string Id => "house";

        public void Extract(ExtractionContext context)
        {
            foreach (var tree in context.Trees)
            {
                var model = context.Compilation.GetSemanticModel(tree);
                foreach (var call in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
                    if (model.GetSymbolInfo(call).Symbol is IMethodSymbol { Name: "Execute" } && context.OwnerOf(call) is { } caller)
                        context.Dispatch(caller, call, model.GetTypeInfo(call.ArgumentList.Arguments[0].Expression).Type, "Execute");
            }
        }
    }

    [Fact]
    public void A_house_dispatcher_reaches_the_handlers_the_built_in_rule_finds()
    {
        var bytes = Encoding.UTF8.GetBytes(Source);
        var tree = CSharpSyntaxTree.ParseText(Source);
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator).Where(p => p.EndsWith("System.Runtime.dll") || p.EndsWith("System.Private.CoreLib.dll")).Select(p => MetadataReference.CreateFromFile(p));
        var compilation = CSharpCompilation.Create("App", [tree], references, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var index = new DeclarationIndex();
        index.AddTree(tree, "src/App.cs", bytes);
        index.IndexDeclarations(compilation.GetSemanticModel(tree), tree);
        var facts = new List<FactRelationship>();
        var declared = new HashSet<string>();
        var dispatches = new DispatchRegistry();
        var rules = new IExtractor[] { new MediatR(), new HouseDispatcher() };
        foreach (var rule in rules) rule.Extract(new ExtractionContext(compilation, new ProjectFacts("App", "App.csproj", ""), [tree], index, _ => { }, facts.Add, declared, new ServiceRegistry(), dispatches));
        foreach (var rule in rules) rule.Finish();

        var handler = index.LocalIdOf(compilation.GetTypeByMetadataName("App.GetClockHandler")!);
        string Caller(string method) => index.LocalIdOf(compilation.GetTypeByMetadataName("App.Caller")!.GetMembers(method).Single())!;
        var dispatched = facts.Where(f => f.Type == "dispatches_to").Select(f => (f.Source.Symbol, f.Resolution, f.Target?.Symbol, f.Reason, f.Detail?["rule"])).OrderBy(d => d.Resolution).ToList();
        Assert.Equal([(Caller("Known"), "resolved", handler, null, "Execute"), (Caller("Unknown"), "unresolved", null, "outside_capability", "Execute")], dispatched);
    }
}
