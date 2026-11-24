using System;
using System.Threading.Tasks;
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Shop.Application;

namespace Shop.Api;

[ApiController]
[Route("api/[controller]")]
public class OrdersController(IMediator mediator) : ControllerBase
{
    [HttpGet("{id}")]
    public string Get(int id) => "";

    [HttpPost]
    public Task<Guid> Place(PlaceOrder command) => mediator.Send(command);

    [HttpDelete("{id}")]
    public Task<bool> Cancel(Guid id) => mediator.Send(new CancelOrder(id));

    [HttpGet("[action]")]
    public string ListAsync() => "";

    [HttpGet]
    [HttpPost("search")]
    public string Search() => "";

    [Route("~/legacy/orders")]
    [HttpGet]
    [HttpHead]
    public string Legacy() => "";

    public Task Notify(Guid id) => mediator.Publish(new OrderPlaced(id));

    [NonAction]
    public Task<object> Forward(IRequest<object> request) => mediator.Send(request);
}

[ApiController]
[Route("status")]
public class StatusApi
{
    [HttpGet]
    public string Get() => "up";
}

public class HomeController : Controller
{
    public string Index() => "home";
}

[Route("[area]/reports")]
public class ReportsController : ControllerBase
{
    [HttpGet]
    public string Summary() => "";
}

[ApiController]
[Route("api/v1/[controller]")]
public abstract class VersionedController : ControllerBase { }

public class InvoicesController : VersionedController
{
    [HttpGet]
    public string List() => "";
}

[Route("override")]
public class CreditsController : VersionedController
{
    [HttpGet]
    public string List() => "";
}
