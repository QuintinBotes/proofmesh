// Minimal stand-ins for Microsoft.Extensions.DependencyInjection and its HttpClient and options extensions, so the fixture needs no package.
using System;
using Microsoft.Extensions.Configuration;

namespace Microsoft.Extensions.DependencyInjection
{
    public interface IServiceCollection { }

    public static class ServiceCollectionServiceExtensions
    {
        public static IServiceCollection AddScoped<TService, TImplementation>(this IServiceCollection services) where TService : class where TImplementation : class, TService => services;
        public static IServiceCollection AddScoped(this IServiceCollection services, Type serviceType, Type implementationType) => services;
        public static IServiceCollection AddScoped<TService>(this IServiceCollection services, Func<IServiceProvider, TService> implementationFactory) where TService : class => services;
        public static IServiceCollection AddTransient<TService>(this IServiceCollection services) where TService : class => services;
        public static IServiceCollection AddSingleton<TService>(this IServiceCollection services, TService implementationInstance) where TService : class => services;
        public static IServiceCollection AddSingleton<TService>(this IServiceCollection services, Func<IServiceProvider, TService> implementationFactory) where TService : class => services;
    }

    public static class HttpClientFactoryServiceCollectionExtensions
    {
        public static IServiceCollection AddHttpClient<TClient, TImplementation>(this IServiceCollection services) where TClient : class where TImplementation : class, TClient => services;
    }

    public static class OptionsConfigurationServiceCollectionExtensions
    {
        public static IServiceCollection Configure<TOptions>(this IServiceCollection services, IConfiguration config) where TOptions : class => services;
    }
}

namespace Microsoft.Extensions.DependencyInjection.Extensions
{
    public static class ServiceCollectionDescriptorExtensions
    {
        public static void TryAddTransient<TService, TImplementation>(this IServiceCollection collection) where TService : class where TImplementation : class, TService { }
    }
}
