using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Proofmesh.Adapter.CSharp;

/// <summary>Every indexed file and declaration: paths, byte ranges, and the local IDs relationships point at.</summary>
public sealed class DeclarationIndex
{
    private sealed record FileEntry(string Path, int Bom, int[] ByteAt, int LineCount);

    private readonly Dictionary<SyntaxTree, FileEntry> files = [];
    private readonly Dictionary<ISymbol, string> bySymbol = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<SyntaxNode, string> byNode = [];
    private readonly Dictionary<string, List<FactSymbol>> symbolsByPath = [];
    private readonly Dictionary<string, string> moduleByPath = [];
    private readonly HashSet<SyntaxTree> indexed = [];

    public IReadOnlyDictionary<string, List<FactSymbol>> SymbolsByPath => symbolsByPath;
    public string? ModuleOf(string path) => moduleByPath.GetValueOrDefault(path);
    public bool Has(SyntaxTree tree) => files.ContainsKey(tree);

    public void AddTree(SyntaxTree tree, string path, byte[] bytes)
    {
        var text = tree.GetText().ToString();
        var bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0;
        var map = new int[text.Length + 1];
        var b = bom;
        for (var i = 0; i < text.Length; i++)
        {
            map[i] = b;
            var c = text[i];
            if (c < 0x80) b += 1;
            else if (c < 0x800) b += 2;
            else if (char.IsHighSurrogate(c) && i + 1 < text.Length) { b += 4; map[++i] = b - 4; }
            else b += 3;
        }
        map[text.Length] = b;
        var lines = tree.GetText().Lines.Count;
        if (text.EndsWith('\n')) lines--;
        files[tree] = new FileEntry(path, bom, map, Math.Max(1, lines));
    }

    public string? PathOf(SyntaxTree tree) => files.TryGetValue(tree, out var f) ? f.Path : null;

    public FactRange RangeOf(SyntaxTree tree, TextSpan span)
    {
        var f = files[tree];
        var lines = tree.GetLineSpan(span);
        return new FactRange(f.ByteAt[span.Start], f.ByteAt[span.End], lines.StartLinePosition.Line + 1, lines.EndLinePosition.Line + 1);
    }

    /// <summary>The local ID for a symbol declared in an indexed file: partial parts, reduced extension forms, and constructed generics map to their definitions.</summary>
    public string? LocalIdOf(ISymbol symbol)
    {
        var s = symbol switch
        {
            IMethodSymbol m => (ISymbol)((m.ReducedFrom ?? m).OriginalDefinition is var d && d.PartialImplementationPart is { } impl ? impl : d),
            _ => symbol.OriginalDefinition,
        };
        if (bySymbol.TryGetValue(s, out var id)) return id;
        // A file linked into several projects yields one symbol per compilation; its declaring syntax is shared.
        foreach (var r in s.DeclaringSyntaxReferences)
            if (byNode.TryGetValue(r.GetSyntax(), out var byDeclaration)) return byDeclaration;
        if (s is IMethodSymbol { MethodKind: MethodKind.Constructor, IsImplicitlyDeclared: true } ctor) return LocalIdOf(ctor.ContainingType);
        return null;
    }

    public string? OwnerOf(SyntaxNode node)
    {
        for (var n = node.Parent; n is not null; n = n.Parent)
            if (byNode.TryGetValue(n, out var id)) return id;
        return null;
    }

    /// <summary>Registers the module symbol of a file and every declaration in it.</summary>
    public void IndexDeclarations(SemanticModel? model, SyntaxTree tree)
    {
        if (!indexed.Add(tree)) return;
        var path = files[tree].Path;
        var list = symbolsByPath.TryGetValue(path, out var existing) ? existing : symbolsByPath[path] = [];
        var root = tree.GetRoot();
        var f = files[tree];
        if (root.FullSpan.Length > 0 && !moduleByPath.ContainsKey(path))
        {
            var r = new FactRange(f.Bom, f.ByteAt[root.FullSpan.End], 1, f.LineCount);
            var moduleQn = Path.ChangeExtension(path, null);
            var moduleId = $"{path}#module#{moduleQn}#0";
            if (r.EndByte > r.StartByte)
            {
                list.Add(new FactSymbol(moduleId, path, "module", Path.GetFileName(path), moduleQn, r, null));
                byNode[root] = moduleId;
                moduleByPath[path] = moduleId;
            }
        }
        foreach (var node in root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax or TypeDeclarationSyntax or EnumDeclarationSyntax))
        {
            var (kind, declared) = node switch
            {
                RecordDeclarationSyntax r => (r.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) ? "struct" : "class", true),
                ClassDeclarationSyntax => ("class", true),
                StructDeclarationSyntax => ("struct", true),
                InterfaceDeclarationSyntax => ("interface", true),
                EnumDeclarationSyntax => ("enum", true),
                EnumMemberDeclarationSyntax => ("field", true),
                DelegateDeclarationSyntax => ("type_alias", true),
                MethodDeclarationSyntax => ("method", true),
                ConstructorDeclarationSyntax => ("constructor", true),
                PropertyDeclarationSyntax or IndexerDeclarationSyntax => ("property", true),
                _ => ("", false),
            };
            if (declared) Register(model, tree, node, kind, node, list, path);
            else if (node is FieldDeclarationSyntax field)
                foreach (var v in field.Declaration.Variables) Register(model, tree, v, "field", field, list, path);
        }
    }

    private void Register(SemanticModel? model, SyntaxTree tree, SyntaxNode declNode, string kind, SyntaxNode rangeNode, List<FactSymbol> list, string path)
    {
        var symbol = model?.GetDeclaredSymbol(declNode);
        var name = symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } ctor ? ctor.ContainingType.Name : symbol?.Name ?? NameOf(declNode);
        var qualified = symbol is null ? name : Qualified(symbol);
        var range = RangeOf(tree, rangeNode.Span);
        var id = $"{path}#{kind}#{qualified}#{range.StartByte}";
        string? signature = symbol is IMethodSymbol or IPropertySymbol ? SignatureOf(symbol, declNode) : null;
        list.Add(new FactSymbol(id, path, kind, name, qualified, range, signature));
        byNode[declNode] = id;
        if (rangeNode != declNode) byNode.TryAdd(rangeNode, id);
        if (symbol is not null) bySymbol.TryAdd(symbol, id);
    }

    /// <summary>The signature as the source writes it (an alias stays an alias; defaults and attributes are dropped), or Roslyn's display when the syntax has no type text.</summary>
    private static string SignatureOf(ISymbol symbol, SyntaxNode declNode)
    {
        static string Text(SyntaxNode n) => System.Text.RegularExpressions.Regex.Replace(n.WithoutTrivia().ToFullString(), @"\s+", " ").Trim();
        static string Params(BaseParameterListSyntax list) => string.Join(", ", list.Parameters.Select(p => string.Join(" ", p.Modifiers.Select(m => m.Text).Concat(p.Type is null ? [] : [Text(p.Type)]).Append(p.Identifier.Text))));
        return declNode switch
        {
            PropertyDeclarationSyntax p => $"{Text(p.Type)} {p.Identifier.Text}",
            IndexerDeclarationSyntax i => $"{Text(i.Type)} this[{Params(i.ParameterList)}]",
            MethodDeclarationSyntax m => $"{Text(m.ReturnType)} {m.Identifier.Text}{(m.TypeParameterList is null ? "" : Text(m.TypeParameterList))}({Params(m.ParameterList)})",
            ConstructorDeclarationSyntax c => $"{c.Identifier.Text}({Params(c.ParameterList)})",
            _ => symbol.ToDisplayString(SignatureFormat),
        };
    }

    private static readonly SymbolDisplayFormat QualifiedFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Omitted,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters);

    private static readonly SymbolDisplayFormat SignatureFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Omitted,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameOnly,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeType,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    public static string Qualified(ISymbol symbol) => symbol switch
    {
        INamedTypeSymbol t => t.ToDisplayString(QualifiedFormat),
        IMethodSymbol { MethodKind: MethodKind.Constructor } c => $"{c.ContainingType.ToDisplayString(QualifiedFormat)}.{c.ContainingType.Name}",
        _ when symbol.ContainingType is { } ct => $"{ct.ToDisplayString(QualifiedFormat)}.{symbol.Name}",
        _ => symbol.Name,
    };

    private static string NameOf(SyntaxNode node) => node switch
    {
        BaseTypeDeclarationSyntax t => t.Identifier.Text,
        MethodDeclarationSyntax m => m.Identifier.Text,
        PropertyDeclarationSyntax p => p.Identifier.Text,
        VariableDeclaratorSyntax v => v.Identifier.Text,
        _ => node.Kind().ToString(),
    };

    public static byte[] Utf8(string s) => Encoding.UTF8.GetBytes(s);
}
