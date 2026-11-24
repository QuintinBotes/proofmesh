// Minimal stand-ins for ASP.NET Core MVC attributes, controllers, and minimal API routing, so the fixture needs no framework reference.
using System;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Microsoft.AspNetCore.Mvc
{
    [AttributeUsage(AttributeTargets.Class, Inherited = true)]
    public class ControllerAttribute : Attribute { }

    public class ApiControllerAttribute : ControllerAttribute { }

    public class NonActionAttribute : Attribute { }

    public class RouteAttribute : Attribute
    {
        public RouteAttribute(string template) { }
    }

    public class HttpGetAttribute : Routing.HttpMethodAttribute
    {
        public HttpGetAttribute() : base(null) { }
        public HttpGetAttribute(string template) : base(template) { }
    }

    public class HttpPostAttribute : Routing.HttpMethodAttribute
    {
        public HttpPostAttribute() : base(null) { }
        public HttpPostAttribute(string template) : base(template) { }
    }

    public class HttpDeleteAttribute : Routing.HttpMethodAttribute
    {
        public HttpDeleteAttribute(string template) : base(template) { }
    }

    public class HttpHeadAttribute : Routing.HttpMethodAttribute
    {
        public HttpHeadAttribute() : base(null) { }
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

    public sealed class RouteGroupBuilder : IEndpointRouteBuilder { }
}

namespace Microsoft.AspNetCore.Builder
{
    using Microsoft.AspNetCore.Routing;

    public sealed class WebApplicationBuilder
    {
        public IServiceCollection Services { get; } = null!;
        public IConfiguration Configuration { get; } = null!;
        public WebApplication Build() => null!;
    }

    public sealed class WebApplication : IEndpointRouteBuilder
    {
        public static WebApplicationBuilder CreateBuilder(string[] args) => null!;
        public void Run() { }
    }

    public static class EndpointRouteBuilderExtensions
    {
        public static RouteGroupBuilder MapGroup(this IEndpointRouteBuilder endpoints, string prefix) => null!;
        public static IEndpointRouteBuilder MapGet(this IEndpointRouteBuilder endpoints, string pattern, Delegate handler) => endpoints;
        public static IEndpointRouteBuilder MapPost(this IEndpointRouteBuilder endpoints, string pattern, Delegate handler) => endpoints;
        public static IEndpointRouteBuilder MapDelete(this IEndpointRouteBuilder endpoints, string pattern, Delegate handler) => endpoints;
    }
}
