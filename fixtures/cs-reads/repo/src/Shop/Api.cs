using Microsoft.AspNetCore.Mvc;
using Shop.Data;

namespace Shop.Api;

public interface ISummaries { string Describe(int id); }

public sealed class Summaries(Store store) : ISummaries
{
    public string Describe(int id)
    {
        var order = store.Order(id);
        var customer = store.Customer(order.CustomerId);
        order.Notes = "seen";
        Audit.Record(order);
        return $"{customer.Name}: {order.Total} on {order.Created}";
    }
}

[ApiController]
[Route("api/orders")]
public class OrdersController(ISummaries summaries) : ControllerBase
{
    [HttpGet("{id}/summary")]
    public string Summary(int id) => summaries.Describe(id);
}

public static class Reports
{
    public static decimal Discounts(Order order) => order.Discount;
}

public sealed class CustomerQueries(ShopContext context)
{
    public object All() => context.Customers;
}

[ApiController]
[Route("api/customers")]
public class CustomersController(CustomerQueries queries) : ControllerBase
{
    [HttpGet("all")]
    public object All() => queries.All();
}
