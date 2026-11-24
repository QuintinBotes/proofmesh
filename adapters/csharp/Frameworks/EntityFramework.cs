using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// Entity-to-table mappings for EF Core and EF6. An explicit ToTable call or [Table] attribute wins over the DbSet convention.
/// EF Core names a convention table after the DbSet property, or after the entity when only a fluent Entity&lt;T&gt;() call registers it.
/// EF6 pluralizes the entity name unless the DbContext removes the pluralizing convention; the plural is inferred by a simple rule and
/// says so. A lightweight convention (modelBuilder.Types().Configure(c =&gt; c.ToTable(...))) names tables from the CLR type: a name built
/// from constants and <c>c.ClrType.Name</c> is evaluated; one built from <c>Helper(c.ClrType).Name</c> is taken as the entity's own name
/// and marked inferred, because the helper may map a type to another; anything else stays unresolved.
/// </summary>
public sealed class EntityFramework : IExtractor
{
    public string Id => "entity_framework";

    private sealed record Convention(ExtractionContext Context, INamedTypeSymbol Entity, string EntityId, INamedTypeSymbol DbContext, PropertyDeclarationSyntax? Property, string PropertyName, bool Ef6, SyntaxNode? Registration = null)
    {
        public SyntaxNode Site => Property ?? Registration!;
        public string Rule => Property is null ? "entity_convention" : "dbset_convention";
    }

    private readonly List<Convention> conventions = [];
    private readonly HashSet<string> explicitlyMapped = new(StringComparer.Ordinal);
    // Contexts are keyed by qualified name: a context declared in one project and derived from in another is a different symbol in
    // each project's compilation when Roslyn retargets it, so symbol equality would miss the convention a base context registers.
    private readonly HashSet<string> unpluralizedContexts = new(StringComparer.Ordinal);
    private readonly HashSet<string> customConventionContexts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Lightweight> lightweight = new(StringComparer.Ordinal);

    /// <summary>A lightweight convention's table name: literal parts around the entity name, an optional base type it applies to, and its schema.</summary>
    private sealed record Lightweight(string Prefix, string Suffix, string? Helper, string? Schema, string? SchemaUnknown, string? AppliesTo);

    public void Extract(ExtractionContext context)
    {
        foreach (var tree in context.Trees)
        {
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                switch (node)
                {
                    case PropertyDeclarationSyntax property
                        when model.GetDeclaredSymbol(property) is IPropertySymbol { ContainingType: { } dbContext, Type: INamedTypeSymbol type, Name: var propertyName }
                             && DbSetFlavor(type) is { } ef6 && type.TypeArguments[0] is INamedTypeSymbol entity && context.LocalIdOf(entity) is { } entityId:
                        conventions.Add(new Convention(context, entity, entityId, dbContext, property, propertyName, ef6));
                        break;
                    case AttributeSyntax attribute
                        when model.GetSymbolInfo(attribute).Symbol is IMethodSymbol { ContainingType: var attributeType } && IsType(attributeType, "System.ComponentModel.DataAnnotations.Schema", "TableAttribute")
                             && attribute.Parent?.Parent is ClassDeclarationSyntax declaration && model.GetDeclaredSymbol(declaration) is { } entity && context.LocalIdOf(entity) is { } entityId:
                    {
                        explicitlyMapped.Add(Key((ITypeSymbol)entity));
                        var arguments = attribute.ArgumentList?.Arguments ?? default;
                        var name = arguments.FirstOrDefault(a => a.NameEquals is null) is { } first ? model.GetConstantValue(first.Expression).Value as string : null;
                        var schema = arguments.FirstOrDefault(a => a.NameEquals?.Name.Identifier.Text == "Schema") is { } s ? model.GetConstantValue(s.Expression).Value as string : null;
                        Map(context, entityId, attribute, name, schema, "Table");
                        break;
                    }
                    case InvocationExpressionSyntax invocation when model.GetSymbolInfo(invocation).Symbol is IMethodSymbol method && IsEf(method.ContainingNamespace):
                        if (method.Name == "Remove" && method.TypeArguments is [{ Name: "PluralizingTableNameConvention" }]
                            && model.GetEnclosingSymbol(invocation.SpanStart)?.ContainingType is { } owner)
                            unpluralizedContexts.Add(Key(owner));
                        // shortcut: only lightweight Types() conventions are seen; add Conventions.Add when a custom IStoreModelConvention shows up.
                        // A lightweight convention that never calls ToTable, such as one that only ignores properties, names no table.
                        else if (method is { Name: "Types", ContainingType.Name: "DbModelBuilder" } && model.GetEnclosingSymbol(invocation.SpanStart)?.ContainingType is { } configured && NamesTables(invocation))
                        {
                            customConventionContexts.Add(Key(configured));
                            if (LightweightTable(model, invocation, method) is { } naming) lightweight.TryAdd(Key(configured), naming);
                        }
                        else if (method is { Name: "Entity", Arity: 1, ContainingType.Name: "ModelBuilder" } && method.TypeArguments[0] is INamedTypeSymbol fluent && context.LocalIdOf(fluent) is { } fluentId
                                 && model.GetEnclosingSymbol(invocation.SpanStart)?.ContainingType is { } registrar && invocation.Parent is not MemberAccessExpressionSyntax)
                            // A bare builder.Entity<T>() registers an entity the context has no DbSet for; a chained call is a configuration, handled above or below.
                            conventions.Add(new Convention(context, fluent, fluentId, registrar, null, fluent.Name, false, invocation));
                        else if (method.Name == "ToTable" && BuilderEntity(Receiver(model, invocation, method)) is { } mapped && context.LocalIdOf(mapped) is { } mappedId)
                        {
                            explicitlyMapped.Add(Key((ITypeSymbol)mapped));
                            var arguments = invocation.ArgumentList.Arguments;
                            var nameArgument = arguments.FirstOrDefault(a => a.NameColon?.Name.Identifier.Text is "name" or "tableName") ?? arguments.FirstOrDefault();
                            var schemaArgument = arguments.FirstOrDefault(a => a.NameColon?.Name.Identifier.Text is "schema" or "schemaName") ?? (arguments.Count > 1 && arguments[1].NameColon is null ? arguments[1] : null);
                            var name = nameArgument is null ? null : model.GetConstantValue(nameArgument.Expression).Value as string;
                            var schema = schemaArgument is null ? null : model.GetConstantValue(schemaArgument.Expression).Value as string;
                            Map(context, mappedId, invocation, name, schema, "ToTable");
                        }
                        break;
                }
            }
        }
    }

    public void Finish()
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var c in conventions.Where(c => !explicitlyMapped.Contains(Key(c.Entity))).OrderBy(c => c.Property is null))
        {
            if (!seen.Add(Key(c.Entity))) continue;
            if (!c.Ef6) Map(c.Context, c.EntityId, c.Site, c.PropertyName, null, c.Rule);
            else if (BaseTypes(c.DbContext).Select(Key).FirstOrDefault(customConventionContexts.Contains) is { } configured)
            {
                if (lightweight.GetValueOrDefault(configured) is { } n && (n.AppliesTo is null || BaseTypes(c.Entity).Select(Key).Contains(n.AppliesTo)))
                {
                    var notes = new List<string>();
                    if (n.Helper is not null) notes.Add($"the convention names the table after {n.Helper}(type).Name, taken here as the entity's own name; {n.Helper} may map a type to another, such as a base type");
                    if (n.SchemaUnknown is not null) notes.Add($"the schema comes from {n.SchemaUnknown}, which is not a compile-time constant");
                    Map(c.Context, c.EntityId, c.Site, n.Prefix + c.Entity.Name + n.Suffix, n.Schema, "custom_convention", notes.Count > 0 ? string.Join("; ", notes) : null);
                }
                else c.Context.Unresolved("maps_to", c.EntityId, c.Site, "outside_capability", Rule("custom_convention", "a convention the DbContext registers may name the table at runtime"));
            }
            else if (BaseTypes(c.DbContext).Select(Key).Any(unpluralizedContexts.Contains)) Map(c.Context, c.EntityId, c.Site, c.Entity.Name, null, c.Rule);
            else Map(c.Context, c.EntityId, c.Site, Pluralize(c.Entity.Name), null, c.Rule, "EF6 pluralizes the entity name; the plural is inferred by a simple rule, so an irregular noun may differ");
        }
    }

    /// <summary>False only for a <c>Types().Configure(lambda)</c> whose lambda calls no ToTable; any other shape may name tables.</summary>
    private static bool NamesTables(InvocationExpressionSyntax types)
    {
        if (types.Parent is not MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Configure", Parent: InvocationExpressionSyntax call }) return true;
        if (call.ArgumentList.Arguments is not [{ Expression: LambdaExpressionSyntax lambda }]) return true;
        return lambda.DescendantNodes().OfType<InvocationExpressionSyntax>().Any(i => InvocationName(i) == "ToTable");
    }

    /// <summary>The table naming of <c>Types().Configure(c =&gt; c.ToTable(name[, schema]))</c>, when the name is constants around the entity's CLR type name.</summary>
    private static Lightweight? LightweightTable(SemanticModel model, InvocationExpressionSyntax types, IMethodSymbol method)
    {
        if (types.Parent is not MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Configure" } configure || configure.Parent is not InvocationExpressionSyntax call
            || call.ArgumentList.Arguments is not [{ Expression: SimpleLambdaExpressionSyntax lambda }]) return null;
        var parameter = lambda.Parameter.Identifier.ValueText;
        var toTable = lambda.DescendantNodes().OfType<InvocationExpressionSyntax>().FirstOrDefault(i => i.Expression is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ToTable", Expression: IdentifierNameSyntax receiver } && receiver.Identifier.ValueText == parameter);
        if (toTable?.ArgumentList.Arguments is not { Count: > 0 } arguments) return null;
        string? helper = null;
        var parts = new List<string?>();
        if (!Parts(arguments[0].Expression)) return null;
        var at = parts.IndexOf(null);
        if (at < 0 || parts.Count(p => p is null) != 1) return null;
        var schemaExpression = arguments.Count > 1 ? arguments[1].Expression : null;
        var schema = schemaExpression is null ? null : Text(model, schemaExpression);
        return new Lightweight(string.Concat(parts.Take(at)), string.Concat(parts.Skip(at + 1)), helper, schema, schemaExpression is not null && schema is null ? schemaExpression.ToString() : null, method.TypeArguments.FirstOrDefault() is { } applies ? Key(applies) : null);

        // Literal parts as strings and the entity name as null; false when the expression is anything else.
        bool Parts(ExpressionSyntax e)
        {
            switch (e)
            {
                case ParenthesizedExpressionSyntax p: return Parts(p.Expression);
                case BinaryExpressionSyntax b when b.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AddExpression): return Parts(b.Left) && Parts(b.Right);
                case InterpolatedStringExpressionSyntax s:
                    foreach (var c in s.Contents)
                        if (c is InterpolatedStringTextSyntax t) parts.Add(t.TextToken.ValueText);
                        else if (c is not InterpolationSyntax { AlignmentClause: null, FormatClause: null } i || !Parts(i.Expression)) return false;
                    return true;
                case MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Name", Expression: var type } when IsClrType(type):
                    parts.Add(null);
                    return true;
                case MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Name", Expression: InvocationExpressionSyntax mapped } when mapped.ArgumentList.Arguments.Any(a => IsClrType(a.Expression)):
                    helper = InvocationName(mapped);
                    parts.Add(null);
                    return true;
                default:
                    if (Text(model, e) is not { } literal) return false;
                    parts.Add(literal);
                    return true;
            }
        }

        bool IsClrType(ExpressionSyntax e) => e is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ClrType", Expression: IdentifierNameSyntax p } && p.Identifier.ValueText == parameter;
    }

    /// <summary>EF6's default table name, by the common English rules; irregular nouns are not modelled, and the mapping says so.</summary>
    internal static string Pluralize(string name) =>
        name.Length > 1 && name.EndsWith('y') && !"aeiou".Contains(char.ToLowerInvariant(name[^2])) ? name[..^1] + "ies"
        : name.EndsWith("s", StringComparison.Ordinal) || name.EndsWith("x", StringComparison.Ordinal) || name.EndsWith("z", StringComparison.Ordinal) || name.EndsWith("ch", StringComparison.Ordinal) || name.EndsWith("sh", StringComparison.Ordinal) ? name + "es"
        : name + "s";

    private static void Map(ExtractionContext context, string entityId, SyntaxNode site, string? name, string? schema, string rule, string? inferred = null)
    {
        if (name is null)
        {
            context.Unresolved("maps_to", entityId, site, "outside_capability", Rule(rule, "the table name is not a compile-time constant"));
            return;
        }
        var table = context.Declare("table", schema is null ? name : $"{schema}.{name}", site, name);
        var detail = Rule(rule);
        if (inferred is not null) detail["inferred"] = inferred;
        context.Relate("maps_to", entityId, site, table, detail);
    }

    /// <summary>True for an EF6 DbSet, false for an EF Core one, null for anything else.</summary>
    private static bool? DbSetFlavor(INamedTypeSymbol type) => type.OriginalDefinition switch
    {
        { Name: "DbSet" or "IDbSet", Arity: 1 } t when Namespace(t) == "System.Data.Entity" => true,
        { Name: "DbSet", Arity: 1 } t when Namespace(t) == "Microsoft.EntityFrameworkCore" => false,
        _ => null,
    };

    private static ITypeSymbol? Receiver(SemanticModel model, InvocationExpressionSyntax invocation, IMethodSymbol method) =>
        invocation.Expression is MemberAccessExpressionSyntax access ? model.GetTypeInfo(access.Expression).Type
        : method.ReducedFrom is not null ? method.ReceiverType
        : model.GetEnclosingSymbol(invocation.SpanStart)?.ContainingType;

    /// <summary>The entity of an EntityTypeBuilder&lt;T&gt; or EntityTypeConfiguration&lt;T&gt;, found through base types.</summary>
    private static INamedTypeSymbol? BuilderEntity(ITypeSymbol? type) =>
        BaseTypes(type).OfType<INamedTypeSymbol>().FirstOrDefault(t => t is { Name: "EntityTypeBuilder" or "EntityTypeConfiguration", Arity: 1 } && IsEf(t.ContainingNamespace))
            ?.TypeArguments[0] as INamedTypeSymbol;

    private static string Key(ITypeSymbol type) => DeclarationIndex.Qualified(type.OriginalDefinition);

    private static bool IsEf(INamespaceSymbol? ns) => ns?.ToDisplayString() is { } s && (s.StartsWith("Microsoft.EntityFrameworkCore", StringComparison.Ordinal) || s.StartsWith("System.Data.Entity", StringComparison.Ordinal));
}
