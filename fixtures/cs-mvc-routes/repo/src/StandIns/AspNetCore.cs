// Minimal stand-ins for ASP.NET Core MVC controllers and conventional routing, so the fixture needs no framework reference.
using System;

namespace Microsoft.AspNetCore.Mvc
{
    [AttributeUsage(AttributeTargets.Class, Inherited = true)]
    public class ControllerAttribute : Attribute { }

    public class NonActionAttribute : Attribute { }

    public class AreaAttribute : Attribute
    {
        public AreaAttribute(string areaName) { }
    }

    public class RouteAttribute : Attribute
    {
        public RouteAttribute(string template) { }
    }

    public class HttpGetAttribute : Routing.HttpMethodAttribute
    {
        public HttpGetAttribute() : base(null) { }
    }

    public class HttpPostAttribute : Routing.HttpMethodAttribute
    {
        public HttpPostAttribute() : base(null) { }
    }

    [Controller]
    public abstract class ControllerBase { }

    public abstract class Controller : ControllerBase { }
}

namespace Microsoft.AspNetCore.Mvc.Routing
{
    public abstract class HttpMethodAttribute : Attribute
    {
        protected HttpMethodAttribute(string? template) { }
    }
}

namespace Microsoft.AspNetCore.Routing
{
    public interface IEndpointRouteBuilder { }
}

namespace Microsoft.AspNetCore.Builder
{
    using Microsoft.AspNetCore.Routing;

    public sealed class WebApplicationBuilder
    {
        public WebApplication Build() => null!;
    }

    public sealed class WebApplication : IEndpointRouteBuilder
    {
        public static WebApplicationBuilder CreateBuilder(string[] args) => null!;
        public void Run() { }
    }

    public static class ControllerEndpointRouteBuilderExtensions
    {
        public static void MapControllerRoute(this IEndpointRouteBuilder endpoints, string name, string pattern, object? defaults = null, object? constraints = null) { }
    }
}
