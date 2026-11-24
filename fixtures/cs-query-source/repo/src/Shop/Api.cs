using Microsoft.AspNetCore.Mvc;
using Shop.Data;
using Shop.Crews;

namespace Shop.Api;

[ApiController]
[Route("api/orders")]
[TendedBy(Crew.Billing)]
public class OrdersController(Store store) : ControllerBase
{
    [HttpGet("open")]
    public bool Open(int id) => store.IsOpen(store.Order(id));
}

[ApiController]
[Route("api/reports")]
[TendedBy(Crew.Search)]
public class ReportsController(Store store) : ControllerBase
{
    [HttpGet("{id}/total")]
    public decimal Total(int id) => store.Order(id).Total;
}

[ApiController]
[Route("api/customers")]
public class CustomersController(Store store) : ControllerBase
{
    [HttpGet("{id}")]
    public string Name(int id) => store.Customer(id).Name;
}
