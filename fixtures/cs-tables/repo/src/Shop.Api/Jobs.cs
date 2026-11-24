using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Shop.Data;

namespace Shop.Api;

public class ShipmentSync(ShipmentRepository shipments) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        shipments.Pending();
        return Task.CompletedTask;
    }
}

public static class Program
{
    public static void Main() { }
}
