// Minimal stand-ins for the EF Core and ASP.NET Core types the rules match, so the fixture needs no package.
using System;

namespace Microsoft.EntityFrameworkCore
{
    public class DbContext { }

    public class DbSet<TEntity> where TEntity : class { }
}

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
