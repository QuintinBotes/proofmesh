using System;
using Microsoft.Extensions.DependencyInjection;
using Shop.Storefront;

var services = new ServiceCollection();
services.AddHttpClient("orders-service", client => client.Timeout = TimeSpan.FromSeconds(5));
services.AddHttpClient<ReportsClient>("orders-service");
services.AddHttpClient(Environment.GetEnvironmentVariable("PAYMENTS_CLIENT") ?? "payments");
services.AddCatalog();
services.AddHttpClient<ICatalogClient, CatalogClient>();

static class Registration
{
    public static IHttpClientBuilder AddCatalog(this IServiceCollection services) => services.AddHttpClient<ICatalogClient, CatalogClient>(CatalogClient.Name);
}
