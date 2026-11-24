using System.Threading.Tasks;
using Confluent.Kafka;
using Refit;

namespace Store.Clients;

public interface IOrdersApi
{
    [Get("/api/orders/{orderId}")]
    Task<string> GetOrder(int orderId);
}

public interface IInventoryApi
{
    [Get("/inventory/{sku}")]
    Task<int> GetStock(string sku);
}

public class OrderEvents(IProducer<string, string> producer)
{
    public Task PublishPlacedAsync(string id) => producer.ProduceAsync("orders.placed", new Message<string, string> { Key = id, Value = id });
}
