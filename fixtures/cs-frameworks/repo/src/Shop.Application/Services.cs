using Microsoft.Extensions.Configuration;

namespace Shop.Application;

public interface IOrderRepository { }
public class OrderRepository : IOrderRepository { }

public interface IClock { }
public class SystemClock : IClock { }

public interface IIdGenerator { }
public class SequentialIds : IIdGenerator { }

public interface IFeatureToggles { }
public static class Toggles
{
    public static IFeatureToggles Create() => null!;
}

public interface IPricing { }
public class Pricing : IPricing
{
    public Pricing(IIdGenerator ids) { }
}

public interface INotifier { }
public class EmailNotifier(IClock clock, IFeatureToggles toggles) : INotifier { }

public class OrderService(IOrderRepository repository, IClock clock, string region) { }

public class PaymentOptions { }

public class PaymentGateway(IConfiguration configuration)
{
    public string? ApiKey() => configuration.GetSection("Payments")["ApiKey"];
}

public interface IAuditLog { }
public class AuditLog(IClock clock) : IAuditLog { }
