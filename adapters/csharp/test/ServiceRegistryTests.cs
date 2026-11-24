using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Proofmesh.Adapter.CSharp.Tests;

public class ServiceRegistryTests
{
    private const string Source = """
        namespace Microsoft.Extensions.DependencyInjection
        {
            public interface IServiceCollection { }
            public static class ServiceCollectionServiceExtensions
            {
                public static IServiceCollection AddScoped<TService, TImplementation>(this IServiceCollection services) where TImplementation : TService => services;
            }
        }
        namespace App
        {
            using Microsoft.Extensions.DependencyInjection;

            public interface IClock { }
            public class Clock : IClock { }
            public interface IRepo { }
            public class Repo : IRepo
            {
                public Repo(IClock clock) { }
            }
            public static class House
            {
                public static void Bind<TService, TImplementation>() { }
            }
            public static class Setup
            {
                public static void Run(Microsoft.Extensions.DependencyInjection.IServiceCollection services)
                {
                    services.AddScoped<IClock, Clock>();
                    House.Bind<IRepo, Repo>();
                }
            }
        }
        """;

    /// <summary>A rules extension for a house registration API: it records each Bind with the shared registry, as an overlay would.</summary>
    private sealed class HouseRegistrations : IExtractor
    {
        public string Id => "house";

        public void Extract(ExtractionContext context)
        {
            foreach (var tree in context.Trees)
            {
                var model = context.Compilation.GetSemanticModel(tree);
                foreach (var call in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
                    if (model.GetSymbolInfo(call).Symbol is IMethodSymbol { Name: "Bind", TypeArguments: [var service, INamedTypeSymbol implementation] } && context.LocalIdOf(service) is { } serviceId)
                        context.RegisterService(serviceId, implementation);
            }
        }
    }

    [Fact]
    public void Constructor_injection_covers_types_an_extension_registers()
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
        var registry = new ServiceRegistry();
        var rules = new IExtractor[] { new DependencyInjection(), new HouseRegistrations() };
        foreach (var rule in rules) rule.Extract(new ExtractionContext(compilation, new ProjectFacts("App", "App.csproj", ""), [tree], index, _ => { }, facts.Add, declared, registry, new DispatchRegistry()));
        foreach (var rule in rules) rule.Finish();

        var injects = facts.Where(f => f.Type == "injects").Select(f => (f.Source.Symbol, f.Target?.Symbol, f.Detail?["rule"])).ToList();
        Assert.Equal([(index.LocalIdOf(compilation.GetTypeByMetadataName("App.Repo")!), index.LocalIdOf(compilation.GetTypeByMetadataName("App.IClock")!), "constructor")], injects);
    }
}
