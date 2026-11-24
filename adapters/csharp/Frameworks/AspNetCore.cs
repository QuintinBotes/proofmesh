using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using static Proofmesh.Adapter.CSharp.Frameworks;

namespace Proofmesh.Adapter.CSharp;

/// <summary>
/// ASP.NET Core inbound HTTP: attribute-routed controller actions and minimal API handlers. Each endpoint, named by verb and route
/// (ANY for an action that accepts every verb), exposes its action, its handler method, or the code that maps a handler lambda.
/// Controller and action templates combine and form selectors as ASP.NET Core does, with [controller] and [action] replaced.
/// An action with no attribute route takes every conventional template (MapControllerRoute) registered by its own project or a
/// project that references it, as ASP.NET Core's application parts do: {controller}, {action}, and {area} are filled in, and a
/// template without them selects only the controller and action its defaults name. An area controller needs an {area} template.
/// Other route tokens, and routes, templates, or group prefixes that are not constants, stay unresolved.
/// </summary>
public sealed class AspNetCore : IExtractor
{
    public string Id => "aspnet_core";

    private const string Mvc = "Microsoft.AspNetCore.Mvc";

    private static readonly Dictionary<string, string> Verbs = new()
    {
        ["HttpGetAttribute"] = "GET", ["HttpPostAttribute"] = "POST", ["HttpPutAttribute"] = "PUT", ["HttpDeleteAttribute"] = "DELETE",
        ["HttpPatchAttribute"] = "PATCH", ["HttpHeadAttribute"] = "HEAD", ["HttpOptionsAttribute"] = "OPTIONS",
    };

    private static readonly Dictionary<string, string> MapVerbs = new() { ["MapGet"] = "GET", ["MapPost"] = "POST", ["MapPut"] = "PUT", ["MapDelete"] = "DELETE", ["MapPatch"] = "PATCH" };

    private static readonly Regex Token = new(@"\[(controller|action)\]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>A [Route] (no verb) or [HttpX] attribute.</summary>
    private sealed record RouteAttribute(string? Verb, string? Template, SyntaxNode Site);

    private sealed record Selector(IReadOnlyList<string> Verbs, string? Template, SyntaxNode Site);

    /// <summary>A conventional template (null when not a constant), its constant defaults, and the projects whose controllers it reaches.</summary>
    private sealed record Conventional(ExtractionContext Context, string Name, string? Template, IReadOnlyDictionary<string, string> Defaults, IReadOnlySet<string> Parts, SyntaxNode Site);

    /// <summary>An action with no attribute route, waiting for the conventional templates of every project.</summary>
    private sealed record Unrouted(ExtractionContext Context, string Assembly, string Controller, string Action, string? Area, IReadOnlyList<string> Verbs, SyntaxNode Site, string ActionId);

    private static readonly Regex Parameter = new(@"\{\**(?<name>[^}:=?]+)[^}]*\}", RegexOptions.CultureInvariant);

    private readonly List<Conventional> conventional = [];
    private readonly List<Unrouted> unrouted = [];

    public void Extract(ExtractionContext context)
    {
        foreach (var tree in context.Trees)
        {
            var model = context.Compilation.GetSemanticModel(tree, ignoreAccessibility: true);
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                switch (node)
                {
                    case ClassDeclarationSyntax declaration when model.GetDeclaredSymbol(declaration) is INamedTypeSymbol controller && IsController(controller):
                        foreach (var method in declaration.Members.OfType<MethodDeclarationSyntax>())
                            if (model.GetDeclaredSymbol(method) is IMethodSymbol action && IsAction(action) && context.LocalIdOf(action) is { } actionId)
                                Action(context, controller, action, method, actionId);
                        break;
                    case InvocationExpressionSyntax invocation when InvocationName(invocation) == "MapControllerRoute":
                        Register(context, model, invocation);
                        break;
                    case InvocationExpressionSyntax invocation when MapVerbs.TryGetValue(InvocationName(invocation), out var verb):
                        Minimal(context, model, invocation, verb);
                        break;
                }
            }
        }
    }

    private static bool IsController(INamedTypeSymbol type) =>
        type is { TypeKind: TypeKind.Class, IsAbstract: false, IsGenericType: false, DeclaredAccessibility: Accessibility.Public }
        && BaseTypes(type).Any(t => IsType(t, Mvc, "ControllerBase") || t.GetAttributes().Any(a => BaseTypes(a.AttributeClass).Any(c => IsType(c, Mvc, "ControllerAttribute"))));

    private static bool IsAction(IMethodSymbol method) =>
        method is { MethodKind: MethodKind.Ordinary, DeclaredAccessibility: Accessibility.Public, IsStatic: false, IsAbstract: false, IsGenericMethod: false }
        && !method.GetAttributes().Any(a => IsType(a.AttributeClass, Mvc, "NonActionAttribute"));

    private void Action(ExtractionContext context, INamedTypeSymbol controller, IMethodSymbol action, MethodDeclarationSyntax declaration, string actionId)
    {
        // ASP.NET Core takes controller routes from the nearest class that declares any, so a derived [Route] replaces the base one.
        var controllerTemplates = BaseTypes(controller).Select(t => Routes(t).Where(r => r is { Verb: null, Template: not null }).Select(r => r.Template).ToList()).FirstOrDefault(l => l.Count > 0) ?? [null];
        var controllerName = controller.Name.Length > "Controller".Length && controller.Name.EndsWith("Controller", StringComparison.Ordinal) ? controller.Name[..^"Controller".Length] : controller.Name;
        var actionName = action.Name.Length > "Async".Length && action.Name.EndsWith("Async", StringComparison.Ordinal) ? action.Name[..^"Async".Length] : action.Name;
        foreach (var selector in Selectors(action, declaration))
            foreach (var controllerTemplate in controllerTemplates)
            {
                if (Combine(controllerTemplate, selector.Template) is not { } template)
                {
                    var area = BaseTypes(controller).SelectMany(t => t.GetAttributes()).FirstOrDefault(a => IsType(a.AttributeClass, Mvc, "AreaAttribute"))?.ConstructorArguments.FirstOrDefault().Value as string;
                    unrouted.Add(new Unrouted(context, context.Compilation.AssemblyName!, controllerName, actionName, area, selector.Verbs, selector.Site, actionId));
                    continue;
                }
                var route = Token.Replace(template, m => m.Groups[1].Value.Equals("controller", StringComparison.OrdinalIgnoreCase) ? controllerName : actionName);
                if (route.Contains('['))
                {
                    context.Unresolved("exposes", actionId, selector.Site, "outside_capability", Rule("attribute_route", "the route uses a token the rules do not model"));
                    continue;
                }
                foreach (var verb in selector.Verbs) Expose(context, verb, route, selector.Site, actionId, "attribute_route");
            }
    }

    // shortcut: MapDefaultControllerRoute, MapAreaControllerRoute, and [ActionName] are not modelled; add them when a repository relies on them.
    private void Register(ExtractionContext context, SemanticModel model, InvocationExpressionSyntax invocation)
    {
        if (model.GetOperation(invocation) is not IInvocationOperation { TargetMethod: var method } operation || !InNamespace(method, "Microsoft.AspNetCore")) return;
        ArgumentSyntax? Argument(string name) => operation.Arguments.FirstOrDefault(a => a.Parameter?.Name == name)?.Syntax as ArgumentSyntax;
        var defaults = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (Argument("defaults")?.Expression is AnonymousObjectCreationExpressionSyntax anonymous)
            foreach (var member in anonymous.Initializers)
                if (member.NameEquals?.Name.Identifier.Text is { } key && Text(model, member.Expression) is { } value) defaults[key] = value;
        var parts = context.Compilation.References.OfType<CompilationReference>().Select(r => r.Compilation.AssemblyName!).Append(context.Compilation.AssemblyName!).ToHashSet(StringComparer.Ordinal);
        var name = Argument("name") is { } n ? Text(model, n.Expression) ?? "" : "";
        conventional.Add(new Conventional(context, name, Argument("pattern") is { } p ? Text(model, p.Expression) : null, defaults, parts, invocation));
    }

    public void Finish()
    {
        foreach (var a in unrouted)
        {
            var reach = conventional.Where(t => t.Parts.Contains(a.Assembly)).ToList();
            var routed = false;
            foreach (var t in reach)
            {
                if (t.Template is null || Route(t.Template, t.Defaults, a) is not { } route) continue;
                routed = true;
                foreach (var verb in a.Verbs)
                    a.Context.Relate("exposes", t.Context.Declare("endpoint", Endpoint(verb, route), t.Site), a.Site, a.ActionId, new Dictionary<string, string> { ["rule"] = "conventional_route", ["route"] = t.Name });
            }
            if (reach.FirstOrDefault(t => t.Template is null) is { } computed)
                a.Context.Unresolved("exposes", a.ActionId, a.Site, "outside_capability", new Dictionary<string, string> { ["rule"] = "conventional_route", ["route"] = computed.Name, ["why"] = "the route template is not a compile-time constant" });
            else if (!routed)
                a.Context.Unresolved("exposes", a.ActionId, a.Site, "outside_capability", conventional.Count == 0
                    ? Rule("attribute_route", "the action is conventionally routed")
                    : Rule("conventional_route", "no registered conventional route reaches the action"));
        }
    }

    /// <summary>
    /// The route a conventional template gives an action, or null when it cannot select it: controller, action, and area each come
    /// from a template parameter or must equal the template's default; an action outside any area needs a template with neither.
    /// </summary>
    private static string? Route(string template, IReadOnlyDictionary<string, string> defaults, Unrouted a)
    {
        var parameters = Parameter.Matches(template).Select(m => m.Groups["name"].Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        bool Selects(string key, string? value) => value is null
            ? !parameters.Contains(key) && !defaults.ContainsKey(key)
            : parameters.Contains(key) || (defaults.TryGetValue(key, out var d) && d.Equals(value, StringComparison.OrdinalIgnoreCase));
        if (!Selects("controller", a.Controller) || !Selects("action", a.Action) || !Selects("area", a.Area)) return null;
        return Parameter.Replace(template, m => m.Groups["name"].Value.ToLowerInvariant() switch
        {
            "controller" => a.Controller,
            "action" => a.Action,
            "area" => a.Area!,
            _ => m.Value,
        });
    }

    private static List<RouteAttribute> Routes(ISymbol symbol)
    {
        var routes = new List<RouteAttribute>();
        foreach (var attribute in symbol.GetAttributes())
        {
            if (attribute is not { AttributeClass: { } type, ApplicationSyntaxReference: { } reference } || Namespace(type) != Mvc) continue;
            var verb = Verbs.GetValueOrDefault(type.Name);
            if (verb is null && type.Name != "RouteAttribute") continue;
            routes.Add(new RouteAttribute(verb, attribute.ConstructorArguments is [{ Value: string template }, ..] ? template : null, reference.GetSyntax()));
        }
        return routes;
    }

    /// <summary>
    /// ASP.NET Core's selectors: one per attribute that carries a template. Verb attributes without a template constrain a [Route]'s verbs,
    /// and beside templated verb attributes they form a selector of their own on the controller's route.
    /// </summary>
    private static List<Selector> Selectors(IMethodSymbol action, MethodDeclarationSyntax declaration)
    {
        var routes = Routes(action);
        var silent = routes.Where(r => r is { Template: null, Verb: not null }).ToList();
        List<string> silentVerbs = silent.Count > 0 ? silent.Select(r => r.Verb!).Distinct().ToList() : ["ANY"];
        var defining = routes.Where(r => r.Template is not null).ToList();
        var selectors = defining.Select(r => new Selector(r.Verb is { } verb ? [verb] : silentVerbs, r.Template, r.Site)).ToList();
        if (defining.Count == 0 || (silent.Count > 0 && defining.All(r => r.Verb is not null)))
            selectors.Add(new Selector(silentVerbs, null, silent.FirstOrDefault()?.Site ?? declaration));
        return selectors;
    }

    /// <summary>An action template starting with / or ~/ replaces the controller's; otherwise the two join. Null when neither exists.</summary>
    private static string? Combine(string? controller, string? action) =>
        action is not null && (action.StartsWith('/') || action.StartsWith("~/", StringComparison.Ordinal)) ? action
        : controller is null ? action
        : action is null ? controller
        : $"{controller.TrimEnd('/')}/{action}";

    private static void Minimal(ExtractionContext context, SemanticModel model, InvocationExpressionSyntax invocation, string verb)
    {
        if (model.GetOperation(invocation) is not IInvocationOperation { TargetMethod: var method } operation || !InNamespace(method, "Microsoft.AspNetCore")) return;
        if (operation.Arguments.FirstOrDefault(a => a.Parameter?.Name == "pattern") is not { Parameter.Ordinal: var ordinal, Syntax: ArgumentSyntax pattern }) return;
        var handler = operation.Arguments.FirstOrDefault(a => a.Parameter?.Ordinal == ordinal + 1)?.Syntax as ArgumentSyntax;
        var named = handler is null ? null : model.GetSymbolInfo(handler.Expression).Symbol as IMethodSymbol ?? model.GetMemberGroup(handler.Expression).OfType<IMethodSymbol>().FirstOrDefault();
        var target = named is { MethodKind: MethodKind.Ordinary } && context.LocalIdOf(named) is { } handlerId ? handlerId : context.OwnerOf(invocation);
        if (target is null) return;
        var prefix = Prefix(model, (invocation.Expression as MemberAccessExpressionSyntax)?.Expression);
        if (prefix is null || Text(model, pattern.Expression) is not { } path)
        {
            context.Unresolved("exposes", target, invocation, "outside_capability", Rule("minimal_api", "the route is not a compile-time constant"));
            return;
        }
        Expose(context, verb, $"{prefix}/{path.TrimStart('/')}", invocation, target, "minimal_api");
    }

    /// <summary>
    /// The path a route builder adds: empty for the application, the MapGroup prefixes for a group, null when a prefix is unknown.
    /// A builder typed as IEndpointRouteBuilder is taken as the application.
    /// </summary>
    private static string? Prefix(SemanticModel model, ExpressionSyntax? receiver)
    {
        if (receiver is null) return null;
        receiver = Origin(model, receiver);
        if (!IsType(model.GetTypeInfo(receiver).Type, "Microsoft.AspNetCore.Routing", "RouteGroupBuilder")) return "";
        return receiver is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax access } group && InvocationName(group) == "MapGroup"
            && Prefix(model, access.Expression) is { } outer && Text(model, group.ArgumentList.Arguments.FirstOrDefault()?.Expression) is { } prefix
            ? $"{outer.TrimEnd('/')}/{prefix.Trim('/')}"
            : null;
    }

    private static void Expose(ExtractionContext context, string verb, string route, SyntaxNode site, string target, string rule)
    {
        var endpoint = context.Declare("endpoint", Endpoint(verb, route), site);
        context.Relate("exposes", endpoint, site, target, Rule(rule));
    }
}
