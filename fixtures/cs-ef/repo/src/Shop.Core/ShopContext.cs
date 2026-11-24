using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;

namespace Shop.Core;

public class Order { }
public class Customer { }
public class AuditEntry { }

[Table("legacy_notes")]
public class Note { }

public class ShopContext : DbContext
{
    public DbSet<Order> Orders { get; set; } = null!;
    public DbSet<Customer> Customers { get; set; } = null!;

    protected void Configure(ModelBuilder builder)
    {
        builder.Entity<Customer>().ToTable("Clients", "sales");
        builder.Entity<AuditEntry>().ToTable(Prefix + "Audit");
        builder.Entity<Shipment>();
    }

    private static string Prefix => System.Environment.GetEnvironmentVariable("PREFIX") ?? "";
}

public class RushOrder : Order { }
public class Shipment { }
