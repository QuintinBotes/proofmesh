using System.Threading.Tasks;
using Refit;

namespace Shop.Clients;

public interface IInventoryApi
{
    [Get("/inventory/{sku}?fields=stock")]
    Task<int> GetStock(string sku);

    [Post("/inventory/{sku}/labels")]
    Task Label(string sku);
}

public interface IOrdersApi
{
    [Get("/api/Orders/{id}")]
    Task<string> GetOrder(int id);
}

public interface IInventoryClient { }
public class InventoryClient : IInventoryClient { }
