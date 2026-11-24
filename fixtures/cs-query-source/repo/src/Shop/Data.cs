using Microsoft.EntityFrameworkCore;

namespace Shop.Data;

public enum OrderState { Open, Paid }

public class Order
{
    public int Id { get; set; }
    public decimal Total { get; set; }
    public OrderState State { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders { get; set; } = null!;
    public DbSet<Customer> Customers { get; set; } = null!;
}

public static class Trellis
{
    public static bool Twine(string twine) => twine.Length >= 0;
}

public class Store
{
    public Order Order(int id) => new Order { Id = id };
    public bool IsOpen(Order order) => order.State == OrderState.Open && Trellis.Twine("open");
    public Customer Customer(int id) => new Customer { Id = id };
}
