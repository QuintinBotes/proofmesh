using System.Threading;
using System.Threading.Tasks;
using Confluent.Kafka;
using Microsoft.Extensions.Hosting;

namespace Shop.Application;

public class ReceiptMailer : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => Task.CompletedTask;
}

public class CacheWarmer : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

public abstract class PollingWorker : BackgroundService { }

public class InventoryPoller : PollingWorker
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => Task.CompletedTask;
}

public class OrderEvents(IProducer<string, string> producer)
{
    private const string Placed = "orders.placed";

    public Task PublishPlacedAsync(string id) => producer.ProduceAsync(Placed, new Message<string, string> { Key = id, Value = id });

    public void PublishCancelled(string id) => producer.Produce("orders.cancelled", new Message<string, string> { Key = id, Value = id });

    public void PublishTo(string topic, string id) => producer.Produce(topic, new Message<string, string> { Key = id, Value = id });
}

public class ShippingListener(IConsumer<string, string> consumer)
{
    public void Start() => consumer.Subscribe("orders.placed");
}
