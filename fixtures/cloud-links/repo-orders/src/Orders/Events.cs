using System.Threading.Tasks;
using Confluent.Kafka;

namespace Orders;

public class OrderEvents(IProducer<string, string> producer)
{
    public Task PublishPlacedAsync(string id) => producer.ProduceAsync("orders.placed", new Message<string, string> { Key = id, Value = id });

    public Task PublishAuditAsync(string id) => producer.ProduceAsync("orders.audit", new Message<string, string> { Key = id, Value = id });
}

public class ShipmentListener(IConsumer<string, string> consumer)
{
    public void Start() => consumer.Subscribe("orders.shipped");
}
