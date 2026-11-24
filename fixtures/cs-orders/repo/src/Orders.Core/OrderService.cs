using Contoso.Missing;
using Orders.Pricing;

namespace Orders.Core;

public class OrderService : IOrderService
{
    public decimal PlaceOrder(decimal price, int quantity)
    {
        var total = PriceCalculator.Calculate(price, quantity);
        new AuditClient().Send(total);
        return total;
    }

    public object Dispatch(dynamic handler) => handler.Run();
}
