namespace Orders.Core;

public interface IOrderService
{
    decimal PlaceOrder(decimal price, int quantity);
}
