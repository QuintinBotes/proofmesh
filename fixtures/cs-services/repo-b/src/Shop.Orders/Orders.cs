namespace Shop.Orders;

public sealed class OrderBook
{
    public int Count { get; private set; }

    public void Place() => Count++;
}
