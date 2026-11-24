using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Shop.Application;
using Shop.Clients;

var builder = WebApplication.CreateBuilder(args);
var services = builder.Services;
var configuration = builder.Configuration;

services.AddScoped<IOrderRepository, OrderRepository>();
services.AddScoped(typeof(IPricing), typeof(Pricing));
services.AddTransient<OrderService>();
services.AddSingleton<IClock>(sp => new SystemClock());
services.AddSingleton<IIdGenerator>(new SequentialIds());
services.AddSingleton<IFeatureToggles>(sp => Toggles.Create());
services.TryAddTransient<INotifier, EmailNotifier>();
services.AddHttpClient<IInventoryClient, InventoryClient>();
services.AddScoped<IAuditLog>(sp => { var clock = new SystemClock(); return new AuditLog(clock); });
services.Configure<PaymentOptions>(configuration.GetSection("Payments"));
var connection = configuration.GetConnectionString("Orders");
var search = configuration["Features:Search"];
var retries = configuration.GetSection("Payments").GetValue<int>("Retries");
var payments = configuration.GetSection("Payments");
var currency = payments.GetValue<string>("Currency");
configuration["Features:Written"] = "on";
var chosen = configuration[args[0]];

var app = builder.Build();
app.MapGet("/health", () => "ok");
var api = app.MapGroup("/api");
api.MapPost("/orders", OrderEndpoints.Place);
api.MapGroup("v2").MapDelete("/orders/{id}", (int id) => id);
app.MapGet(args[1], () => "dynamic");
app.Run();

public static class OrderEndpoints
{
    public static string Place(int id) => "";
}
