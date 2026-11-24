using Contoso.Decoys;
using Microsoft.Extensions.DependencyInjectionSpecs;

namespace Shop.Api.Decoys;

public class DecoyController : ControllerBase
{
    [HttpGet("decoy")]
    public string Get() => "";
}

public class DecoyRequest { }
public class DecoyHandler : IRequestHandler<DecoyRequest, int> { }
public class DecoyWorker : IHostedService { }

public interface IDecoyApi
{
    [Get("/decoy")]
    string Fetch();
}

public interface IDecoyService { }
public class DecoyService : IDecoyService { }

public static class DecoyWiring
{
    public static void Wire(IServiceCollection services, IConfiguration configuration, IProducer<string, string> producer)
    {
        services.AddScoped<IDecoyService, DecoyService>();
        _ = configuration["Decoy:Key"];
        _ = configuration.GetSection("Decoy");
        producer.Produce("decoy-topic", "x");
    }
}
