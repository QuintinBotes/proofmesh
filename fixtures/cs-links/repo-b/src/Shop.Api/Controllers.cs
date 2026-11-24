using Confluent.Kafka;
using Microsoft.AspNetCore.Mvc;
using Shop.Contracts;

namespace Shop.Api;

[ApiController]
[Route("api/[controller]")]
public class OrdersController : ControllerBase
{
    [HttpGet("{id}")]
    public OrderDto Get(int id) => new(id);
}

public class ShippingListener(IConsumer<string, string> consumer)
{
    public void Start() => consumer.Subscribe("orders.placed");
}
