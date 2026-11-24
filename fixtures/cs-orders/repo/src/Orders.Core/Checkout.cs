namespace Orders.Core;

public static class Checkout
{
    public static decimal Buy(IOrderService orders, decimal price) => orders.PlaceOrder(price, 1);
}
