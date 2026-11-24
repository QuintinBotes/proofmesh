// Minimal stand-ins for the ASP.NET Core and hosting types the rules match, so the fixture needs no framework reference.
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Microsoft.AspNetCore.Mvc
{
    [AttributeUsage(AttributeTargets.Class, Inherited = true)]
    public class ControllerAttribute : Attribute { }

    public class ApiControllerAttribute : ControllerAttribute { }

    public class RouteAttribute : Attribute
    {
        public RouteAttribute(string template) { }
    }

    public class HttpGetAttribute : Routing.HttpMethodAttribute
    {
        public HttpGetAttribute(string template) : base(template) { }
    }

    [Controller]
    public abstract class ControllerBase { }
}

namespace Microsoft.AspNetCore.Mvc.Routing
{
    public abstract class HttpMethodAttribute : Attribute
    {
        protected HttpMethodAttribute(string? template) { }
    }
}

namespace Microsoft.Extensions.Hosting
{
    public interface IHostedService
    {
        Task StartAsync(CancellationToken cancellationToken);
        Task StopAsync(CancellationToken cancellationToken);
    }

    public abstract class BackgroundService : IHostedService
    {
        protected abstract Task ExecuteAsync(CancellationToken stoppingToken);
        public virtual Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public virtual Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
