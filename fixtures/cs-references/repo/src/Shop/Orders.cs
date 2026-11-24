using System;
using System.Collections.Generic;
using System.Linq;

namespace Shop;

public enum OrderState { Open, Paid }

public static class Limits
{
    public const int MaxLines = 50;
}

[AttributeUsage(AttributeTargets.Class)]
public sealed class AuditedAttribute : Attribute { }

[Audited]
public class Order
{
    public int Id { get; set; }
    public decimal Total { get; set; }
    public OrderState State { get; set; }
    public int Lines;
}

public class OrderService
{
    private readonly List<Order> orders = new();

    public Order Create(decimal total)
    {
        var order = new Order { Total = total, State = OrderState.Open };
        orders.Add(order);
        return order;
    }

    public bool Pay(Order order)
    {
        if (order.Lines > Limits.MaxLines) throw new InvalidOperationException(nameof(Order.Lines));
        order.State = OrderState.Paid;
        order.Lines++;
        return order.Total > 0;
    }

    public IEnumerable<decimal> Totals() => orders.Select(Total);

    private static decimal Total(Order order) => order.Total;

    public void Broken() => Missing.Thing.Do(1, 2);
}
