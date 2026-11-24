using Microsoft.EntityFrameworkCore;

namespace Shop.Data;

public class Order
{
    public int Id { get; set; }
    public decimal Total { get; set; }
    public string Notes { get; set; } = "";
    public static Order Create() => new Order();
}

public class Shipment
{
    public static Shipment Create() => new Shipment();
}

public class ArchiveEntry
{
    public static ArchiveEntry Create() => new ArchiveEntry();
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders { get; set; } = null!;
    public DbSet<Shipment> Shipments { get; set; } = null!;
    public DbSet<ArchiveEntry> Archive { get; set; } = null!;
}
