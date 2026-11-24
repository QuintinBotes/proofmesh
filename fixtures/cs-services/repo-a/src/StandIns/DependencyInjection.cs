// Minimal stand-ins for Microsoft.Extensions.DependencyInjection and its HttpClient extensions, so the fixture needs no package.
using System;
using System.Net.Http;

namespace Microsoft.Extensions.DependencyInjection
{
    public interface IServiceCollection { }
    public sealed class ServiceCollection : IServiceCollection { }
    public interface IHttpClientBuilder { }

    public static class HttpClientFactoryServiceCollectionExtensions
    {
        public static IHttpClientBuilder AddHttpClient(this IServiceCollection services, string name) => null!;
        public static IHttpClientBuilder AddHttpClient(this IServiceCollection services, string name, Action<HttpClient> configureClient) => null!;
        public static IHttpClientBuilder AddHttpClient<TClient>(this IServiceCollection services, string name) where TClient : class => null!;
        public static IHttpClientBuilder AddHttpClient<TClient, TImplementation>(this IServiceCollection services) where TClient : class where TImplementation : class, TClient => null!;
        public static IHttpClientBuilder AddHttpClient<TClient, TImplementation>(this IServiceCollection services, string name) where TClient : class where TImplementation : class, TClient => null!;
    }
}
