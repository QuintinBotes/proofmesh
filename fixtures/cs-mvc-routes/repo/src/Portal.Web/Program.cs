using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;

var app = WebApplication.CreateBuilder(args).Build();
app.MapControllerRoute("Tenant", "Admin/{tenant:guid}/{controller}/{action}/{id?}");
app.MapControllerRoute("Admin", "Admin/{controller}/{action}/{id?}");
app.MapControllerRoute("Root", "", new { controller = "Home", action = "Index" });
app.MapControllerRoute("Missing", "{*url}", new { controller = "Error", action = "NotFound" });
app.MapControllerRoute("Configured", args[0]);
app.Run();

public class HomeController : Controller
{
    public string Index() => "home";

    [HttpPost]
    public string Save() => "";
}
