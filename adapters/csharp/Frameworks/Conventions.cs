using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// Rules a repository's conventions file configures, for constructs only the repository can name: job base classes, feature flag keys,
/// and the enum whose members name owning teams. Data, not code: the file names types, and these rules match them.
/// </summary>
public sealed class Conventions(JsonNode config) : IExtractor
{
    public string Id => "conventions";

    private readonly string[] jobBases = Names(config["jobs"], "base_type");
    private readonly string[] flagKeyTypes = Names(config["feature_flags"], "key_type");
    private readonly string[] flagClasses = Names(config["feature_flags"], "declared_in");
    private readonly (string Enum, string? Parameter)[] teams = (config["teams"]?.AsArray() ?? []).OfType<JsonObject>()
        .Select(t => (t["enum_type"]!.GetValue<string>(), t["parameter"]?.GetValue<string>())).ToArray();
    private readonly HashSet<(string, string)> evaluated = [];
    private readonly HashSet<(string, string)> owned = [];

    private static string[] Names(JsonNode? list, string key) => (list?.AsArray() ?? []).OfType<JsonObject>().Select(o => o[key]?.GetValue<string>()).OfType<string>().ToArray();

    public void Extract(ExtractionContext context)
    {
        foreach (var tree in context.Trees)
        {
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                switch (node)
                {
                    case ClassDeclarationSyntax declaration when jobBases.Length > 0 && declaration.BaseList is { Types: [var first, ..] }
                        && model.GetDeclaredSymbol(declaration) is INamedTypeSymbol { IsAbstract: false } type && context.LocalIdOf(type) is { } typeId
                        && jobBases.FirstOrDefault(b => BaseTypes(type).Skip(1).Any(t => Matches(t, b))) is { } jobBase:
                    {
                        var job = context.Declare("job", DeclarationIndex.Qualified(type), first, type.Name);
                        context.Relate("runs", job, first, typeId, new Dictionary<string, string> { ["rule"] = "job_base", ["base"] = jobBase });
                        break;
                    }
                    case SimpleNameSyntax name when (flagKeyTypes.Length > 0 || flagClasses.Length > 0 || teams.Length > 0) && model.GetSymbolInfo(name).Symbol is IFieldSymbol or IPropertySymbol:
                    {
                        var member = model.GetSymbolInfo(name).Symbol!;
                        if (FlagKey(member) is { } key && context.OwnerOf(name) is { } reader && FlagDeclaration(member) is { } declared && context.PathOf(declared.SyntaxTree) is not null)
                        {
                            var flag = context.Declare("feature_flag", key, declared, key);
                            if (evaluated.Add((reader, flag))) context.Relate("evaluates_flag", reader, name, flag, Rule("flag_key"));
                        }
                        else if (member is IFieldSymbol { ContainingType.TypeKind: TypeKind.Enum } value && teams.FirstOrDefault(t => Matches(value.ContainingType, t.Enum)) is { Enum: not null } team
                                 && Argument(name) is { } argument && (team.Parameter is null || ParameterOf(model, argument) == team.Parameter)
                                 && value.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is { } enumMember && context.PathOf(enumMember.SyntaxTree) is not null
                                 && context.OwnerOf(argument) is { } owner)
                        {
                            var teamId = context.Declare("team", DeclarationIndex.Qualified(value), enumMember, value.Name);
                            if (owned.Add((owner, teamId))) context.Relate("owned_by", owner, argument, teamId, new Dictionary<string, string> { ["rule"] = "team_argument", ["source"] = "code" });
                        }
                        break;
                    }
                }
            }
        }
    }

    /// <summary>A flag's key: the constant string a configured keys class declares, or the constant first argument a key-typed member is created with.</summary>
    private string? FlagKey(ISymbol member)
    {
        var type = member switch { IFieldSymbol f => f.Type, IPropertySymbol p => p.Type, _ => null };
        if (member is IFieldSymbol { HasConstantValue: true, ConstantValue: string constant } && flagClasses.Any(c => Matches(member.ContainingType, c))) return constant;
        var initializer = FlagDeclaration(member) switch
        {
            VariableDeclaratorSyntax v => v.Initializer?.Value,
            PropertyDeclarationSyntax p => p.Initializer?.Value,
            _ => null,
        };
        if (flagClasses.Any(c => Matches(member.ContainingType, c)) && type?.SpecialType == SpecialType.System_String) return Literal(initializer);
        if (type is not null && flagKeyTypes.Any(k => Matches(type, k)) && initializer is BaseObjectCreationExpressionSyntax { ArgumentList.Arguments: [var first, ..] }) return Literal(first.Expression);
        return null;
    }

    private static SyntaxNode? FlagDeclaration(ISymbol member) => member.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();

    private static string? Literal(ExpressionSyntax? e) => e is LiteralExpressionSyntax { Token.Value: string s } ? s : null;

    /// <summary>The argument a name is the value of. Its owner is the code making the call, or the declaration an attribute decorates.</summary>
    private static SyntaxNode? Argument(SimpleNameSyntax name)
    {
        SyntaxNode n = name.Parent is MemberAccessExpressionSyntax access && access.Name == name ? access : name;
        return n.Parent is ArgumentSyntax or AttributeArgumentSyntax ? n.Parent : null;
    }

    private static string? ParameterOf(SemanticModel model, SyntaxNode argument) => argument switch
    {
        ArgumentSyntax { NameColon: { } named } => named.Name.Identifier.ValueText,
        AttributeArgumentSyntax { NameColon: { } named } => named.Name.Identifier.ValueText,
        AttributeArgumentSyntax { NameEquals: { } property } => property.Name.Identifier.ValueText,
        ArgumentSyntax { Parent: ArgumentListSyntax list } a when list.Parent is { } call && model.GetSymbolInfo(call).Symbol is IMethodSymbol method && list.Arguments.IndexOf(a) is var i && i < method.Parameters.Length => method.Parameters[i].Name,
        AttributeArgumentSyntax { Parent: AttributeArgumentListSyntax list } a when list.Parent is AttributeSyntax attribute && model.GetSymbolInfo(attribute).Symbol is IMethodSymbol ctor && list.Arguments.IndexOf(a) is var i && i < ctor.Parameters.Length => ctor.Parameters[i].Name,
        _ => null,
    };

    /// <summary>A configured type name, matched by its qualified name with or without type parameters.</summary>
    private static bool Matches(ITypeSymbol type, string configured) =>
        DeclarationIndex.Qualified(type.OriginalDefinition) is var qualified && (qualified == configured || Generic.Replace(qualified, "") == Generic.Replace(configured, ""));

    private static readonly Regex Generic = new("<.*>$", RegexOptions.CultureInvariant);
}
