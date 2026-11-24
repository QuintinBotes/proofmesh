using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;

WebApplication.CreateBuilder(args).Build().Run();

public class OrphanController : Controller
{
    public string Index() => "";
}
