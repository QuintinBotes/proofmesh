using Microsoft.AspNetCore.Mvc;
using Shop.Data;

namespace Shop.Api;

[ApiController]
[Route("api/[controller]")]
public class OrdersController(OrderRepository orders) : ControllerBase
{
    [HttpGet("{id}")]
    public Order Get(int id) => orders.Load(id);
}
