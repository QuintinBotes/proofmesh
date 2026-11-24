using System.Data.Entity;

namespace Shop.Archive;

public class Bundle { }

public class ArchiveContext : Shop.Legacy.VoucherContext
{
    public DbSet<Bundle> Bundles { get; set; } = null!;
}
