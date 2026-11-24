using System.Text;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace Proofmesh.Adapter.CSharp.Tests;

public class AdapterUnitTests
{
    [Fact]
    public void Ranges_are_utf8_byte_offsets_after_a_byte_order_mark_and_non_ascii_text()
    {
        var bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes("// é😀\nclass A {}\n")).ToArray();
        var tree = CSharpSyntaxTree.ParseText(SourceText.From(bytes, bytes.Length, Encoding.UTF8, canBeEmbedded: false));
        var index = new DeclarationIndex();
        index.AddTree(tree, "a.cs", bytes);
        var declaration = tree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>().Single();

        var range = index.RangeOf(tree, declaration.Span);

        Assert.Equal(new FactRange(13, 23, 2, 2), range);
        Assert.Equal("class A {}", Encoding.UTF8.GetString(bytes[range.StartByte..range.EndByte]));
    }

    [Fact]
    public void Project_files_are_read_statically_with_inherited_and_central_settings()
    {
        var files = new Dictionary<string, string>
        {
            ["Directory.Build.props"] = "<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>",
            ["Directory.Packages.props"] = "<Project><ItemGroup><PackageVersion Include=\"Contoso.Client\" Version=\"1.2.3\" /></ItemGroup></Project>",
            ["src/App/App.csproj"] = """
                <Project Sdk="Microsoft.NET.Sdk.Web">
                  <ItemGroup>
                    <ProjectReference Include="..\Lib\.\Lib.csproj" />
                    <PackageReference Include="Contoso.Client" />
                    <Compile Remove="Generated\**" />
                  </ItemGroup>
                </Project>
                """,
        };

        var project = StaticProject.Read("/repo", "src/App/App.csproj", files);

        Assert.Equal(("App", true, true), (project.AssemblyName, project.Web, project.ImplicitUsings));
        Assert.Equal(["src/Lib/Lib.csproj"], project.ProjectReferences);
        Assert.Equal([("Contoso.Client", (string?)null)], project.PackageReferences);
        Assert.Equal(["Generated/**"], project.CompileRemoves);
        Assert.Equal("1.2.3", StaticProject.CentralVersions(project.Directory, files)["Contoso.Client"]);
    }

    [Fact]
    public void A_version_override_wins_over_the_central_version_and_using_items_become_global_usings()
    {
        var files = new Dictionary<string, string>
        {
            ["Directory.Packages.props"] = "<Project><ItemGroup><PackageVersion Include=\"Contoso.Test\" Version=\"4.0.0\" /></ItemGroup></Project>",
            ["src/T/T.csproj"] = """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>
                  <ItemGroup>
                    <PackageReference Include="Contoso.Test" VersionOverride="3.1.0" />
                    <Using Include="Contoso.Test.Framework" />
                    <Using Include="Contoso.Test.Legacy.ClassicAssert" Alias="Assert" />
                    <Using Include="System.Math" Static="true" />
                    <Using Remove="System.Net.Http" />
                  </ItemGroup>
                </Project>
                """,
        };

        var project = StaticProject.Read("/repo", "src/T/T.csproj", files);
        Assert.Equal([("Contoso.Test", (string?)"3.1.0")], project.PackageReferences);
        var usings = NoExecutionLoader.GlobalUsings(project).Split('\n');
        Assert.Contains("global using global::Contoso.Test.Framework;", usings);
        Assert.Contains("global using Assert = global::Contoso.Test.Legacy.ClassicAssert;", usings);
        Assert.Contains("global using static global::System.Math;", usings);
        Assert.Contains("global using global::System.Linq;", usings);
        Assert.DoesNotContain("global using global::System.Net.Http;", usings);
    }

    [Fact]
    public void A_cached_package_without_compile_assemblies_is_present_and_a_framework_only_library_is_read()
    {
        var root = Directory.CreateTempSubdirectory("pm-nuget-").FullName;
        void Package(string id, string version, string? lib = null)
        {
            var dir = Path.Combine(root, id, version);
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, $"{id}.{version}.nupkg.sha512"), "c2hh");
            if (lib is not null) { Directory.CreateDirectory(Path.Combine(dir, "lib", lib)); File.WriteAllBytes(Path.Combine(dir, "lib", lib, $"{id}.dll"), []); }
        }
        Package("contoso.analyzers", "1.0.0");
        Package("contoso.legacy", "2.0.0", "net45");
        var before = Environment.GetEnvironmentVariable("NUGET_PACKAGES");
        Environment.SetEnvironmentVariable("NUGET_PACKAGES", root);
        try
        {
            Assert.Equal((true, 0), (Toolchain.InCache("Contoso.Analyzers", "1.0.0"), Toolchain.PackageAssemblies("Contoso.Analyzers", "1.0.0").Count()));
            Assert.Equal("nuget:Contoso.Analyzers/1.0.0 sha512:c2hh", Toolchain.PackageInput("Contoso.Analyzers", "1.0.0"));
            Assert.Single(Toolchain.PackageAssemblies("Contoso.Legacy", "2.0.0"));
            Assert.False(Toolchain.InCache("Contoso.Absent", "1.0.0"));
            File.WriteAllText(Path.Combine(root, "contoso.legacy", "2.0.0", "contoso.legacy.nuspec"), """
                <package><metadata><dependencies>
                  <group targetFramework=".NETFramework4.5"><dependency id="Old.Only" version="1.0.0" /></group>
                  <group targetFramework=".NETStandard2.0"><dependency id="Contoso.Logging" version="[8.0.0, )" /><dependency id="Contoso.Options" version="(7.0.1,9.0.0]" /></group>
                </dependencies></metadata></package>
                """);
            Assert.Equal([("Contoso.Logging", (string?)"8.0.0"), ("Contoso.Options", (string?)"7.0.1")], Toolchain.PackageDependencies("Contoso.Legacy", "2.0.0"));
            File.WriteAllText(Path.Combine(root, "contoso.analyzers", "1.0.0", "contoso.analyzers.nuspec"), "<package><metadata><dependencies><dependency id=\"Flat.Dep\" version=\"2.1.0\" /></dependencies></metadata></package>");
            Assert.Equal([("Flat.Dep", (string?)"2.1.0")], Toolchain.PackageDependencies("Contoso.Analyzers", "1.0.0"));
            Assert.Empty(Toolchain.PackageDependencies("Contoso.Absent", "1.0.0"));
            Assert.Equal("nuget:Contoso.Absent/1.0.0 missing", Toolchain.PackageInput("Contoso.Absent", "1.0.0"));
        }
        finally
        {
            Environment.SetEnvironmentVariable("NUGET_PACKAGES", before);
        }
    }

    [Fact]
    public void A_reference_is_named_by_its_assembly_so_a_dotted_project_name_is_not_cut_at_its_last_dot()
    {
        var project = Microsoft.CodeAnalysis.CSharp.CSharpCompilation.Create("Contoso.Shared.Library").ToMetadataReference();
        Assert.Equal("Contoso.Shared.Library", NoExecutionLoader.AssemblyNameOf(project));
        var file = Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(typeof(object).Assembly.Location);
        Assert.Equal(Path.GetFileNameWithoutExtension(typeof(object).Assembly.Location), NoExecutionLoader.AssemblyNameOf(file));
    }

    [Fact]
    public void A_package_reference_written_with_an_msbuild_property_is_an_unevaluated_input_not_a_missing_one()
    {
        var files = new Dictionary<string, string>
        {
            ["Directory.Packages.props"] = "<Project><ItemGroup><PackageVersion Include=\"$(CoveragePackage).Core\" Version=\"$(CoverageVersion)\" /></ItemGroup></Project>",
            ["src/App/App.csproj"] = "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><PackageReference Include=\"$(CoveragePackage).Core\" /></ItemGroup></Project>",
            ["src/App/A.cs"] = "class A {}",
        };
        var root = Directory.CreateTempSubdirectory("pm-unevaluated-").FullName;
        Directory.CreateDirectory(Path.Combine(root, "src", "App"));
        File.WriteAllText(Path.Combine(root, "src", "App", "A.cs"), files["src/App/A.cs"]);
        var ws = new CapturedWorkspace(root, ["src/App/A.cs"], files);
        var diagnostics = new List<Diagnostic>();
        var inputs = new SortedSet<string>(StringComparer.Ordinal);

        var loaded = NoExecutionLoader.Load(ws, new DeclarationIndex(), new Dictionary<string, Microsoft.CodeAnalysis.SyntaxTree>(), diagnostics, _ => { }, inputs);

        Assert.Contains("nuget:$(CoveragePackage).Core/$(CoverageVersion) unevaluated", inputs);
        Assert.False(loaded.Single().DependenciesMissing);
        Assert.Contains(diagnostics, d => d.Message.Contains("cannot evaluate"));
    }
}
