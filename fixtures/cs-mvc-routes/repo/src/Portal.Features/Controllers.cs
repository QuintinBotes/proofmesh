using Microsoft.AspNetCore.Mvc;

namespace Portal.Features;

public class ReportsController : Controller
{
    [HttpGet]
    public string Summary() => "";

    [NonAction]
    public string Helper() => "";
}

public class ErrorController : Controller
{
    public string NotFound() => "";
}

[Route("api/things")]
public class ThingsController : ControllerBase
{
    [HttpGet]
    public string List() => "";
}

[Area("Billing")]
public class InvoicesController : Controller
{
    public string Index() => "";
}
