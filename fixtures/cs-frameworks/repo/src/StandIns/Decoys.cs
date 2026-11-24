// Types named like the framework types the rules match, in other namespaces. No rule may fire on them.
using System;

namespace Microsoft.Extensions.DependencyInjectionSpecs
{
    public interface IServiceCollection { }

    public static class ServiceCollectionServiceExtensions
    {
        public static IServiceCollection AddScoped<TService, TImplementation>(this IServiceCollection services) => services;
    }
}

namespace Contoso.Decoys
{
    public abstract class ControllerBase { }

    public class HttpGetAttribute : Attribute
    {
        public HttpGetAttribute(string template) { }
    }

    public class GetAttribute : Attribute
    {
        public GetAttribute(string path) { }
    }

    public interface IRequestHandler<TRequest, TResponse> { }

    public interface IHostedService { }

    public interface IConfiguration
    {
        string? this[string key] { get; }
        IConfiguration GetSection(string key);
    }

    public interface IProducer<TKey, TValue>
    {
        void Produce(string topic, TValue value);
    }
}
