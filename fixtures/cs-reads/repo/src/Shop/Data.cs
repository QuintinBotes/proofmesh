using Microsoft.EntityFrameworkCore;

namespace Shop.Data;

public abstract class Entity
{
    public System.DateTime Created { get; set; }
}

public class Order : Entity
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public decimal Total { get; set; }
    public decimal Discount { get; set; }
    public string Notes { get; set; } = "";
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

public class Store
{
    public Order Order(int id) => new Order { Id = id };
    public Customer Customer(int id) => new Customer { Id = id };
}
