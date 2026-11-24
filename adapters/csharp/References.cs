using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// Uses of repository declarations other than calls: a type named in code, a property or field read or written, a constant or enum
/// member used, an object created, a method passed as a delegate. Names that bind outside the repository, or not at all, are not recorded.
/// </summary>
public static class References
{
    public sealed record Reference(string Target, string Use, SyntaxNode Site);

    public static Reference? Of(SemanticModel model, SimpleNameSyntax name, DeclarationIndex index)
    {
        if (name.IsVar || IsCallee(name) || Inside<BaseListSyntax>(name) || Inside<UsingDirectiveSyntax>(name) || Inside<BaseNamespaceDeclarationSyntax>(name, stopAt: n => n is MemberDeclarationSyntax and not BaseNamespaceDeclarationSyntax)) return null;
        var symbol = model.GetSymbolInfo(name).Symbol;
        var expression = Accessed(name);
        var nameOf = InNameOf(model, name);
        switch (symbol)
        {
            case IMethodSymbol { MethodKind: MethodKind.Constructor } ctor when name.Parent is AttributeSyntax || name.Parent?.Parent is AttributeSyntax:
                return Local(ctor.ContainingType, "attribute", name);
            case IMethodSymbol method:
                return Local(method, nameOf ? "nameof" : "method_group", expression);
            case INamedTypeSymbol type:
                return Local(type, nameOf ? "nameof" : Created(name) ? "create" : name.Parent is AttributeSyntax || name.Parent?.Parent is AttributeSyntax ? "attribute" : "type", name);
            case IPropertySymbol or IFieldSymbol:
                return Local(symbol, nameOf ? "nameof" : Access(expression), expression);
            default:
                return null;
        }

        Reference? Local(ISymbol target, string use, SyntaxNode site) => index.LocalIdOf(target) is { } id ? new Reference(id, use, site) : null;
    }

    /// <summary>The name, or the member access it ends, which is what is read or written.</summary>
    private static ExpressionSyntax Accessed(SimpleNameSyntax name) => name.Parent switch
    {
        MemberAccessExpressionSyntax access when access.Name == name => access,
        MemberBindingExpressionSyntax binding when binding.Name == name => binding,
        _ => name,
    };

    /// <summary>The name a call invokes: a call relationship records it, so it is not a reference too.</summary>
    private static bool IsCallee(SimpleNameSyntax name) => Accessed(name) is var e && e.Parent is InvocationExpressionSyntax invocation && invocation.Expression == e;

    private static bool Created(SimpleNameSyntax name)
    {
        SyntaxNode n = name;
        while (n.Parent is QualifiedNameSyntax or AliasQualifiedNameSyntax) n = n.Parent;
        return n.Parent is ObjectCreationExpressionSyntax creation && creation.Type == n;
    }

    private static string Access(ExpressionSyntax e)
    {
        while (e.Parent is ParenthesizedExpressionSyntax p) e = p;
        return e.Parent switch
        {
            AssignmentExpressionSyntax assignment when assignment.Left == e => assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) ? "write" : "read_write",
            PrefixUnaryExpressionSyntax u when u.IsKind(SyntaxKind.PreIncrementExpression) || u.IsKind(SyntaxKind.PreDecrementExpression) => "read_write",
            PostfixUnaryExpressionSyntax u when u.IsKind(SyntaxKind.PostIncrementExpression) || u.IsKind(SyntaxKind.PostDecrementExpression) => "read_write",
            ArgumentSyntax { RefKindKeyword.RawKind: (int)SyntaxKind.OutKeyword } => "write",
            ArgumentSyntax { RefKindKeyword.RawKind: (int)SyntaxKind.RefKeyword } => "read_write",
            _ => "read",
        };
    }

    private static bool InNameOf(SemanticModel model, SyntaxNode node)
    {
        for (var n = node.Parent; n is not null and not StatementSyntax and not MemberDeclarationSyntax; n = n.Parent)
            if (n is InvocationExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.ValueText: "nameof" } } invocation)
                return model.GetOperation(invocation) is Microsoft.CodeAnalysis.Operations.INameOfOperation;
        return false;
    }

    private static bool Inside<T>(SyntaxNode node, Func<SyntaxNode, bool>? stopAt = null) where T : SyntaxNode
    {
        for (var n = node.Parent; n is not null; n = n.Parent)
        {
            if (n is T) return true;
            if (stopAt?.Invoke(n) == true) return false;
        }
        return false;
    }
}
