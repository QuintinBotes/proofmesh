using System.Data.Entity;
using System.Data.Entity.ModelConfiguration;
using System.Data.Entity.ModelConfiguration.Conventions;

namespace Shop.Legacy;

public class Invoice { }
public class Payment { }
public class Refund { }

public class BillingContext : DbContext
{
    public DbSet<Invoice> Invoices { get; set; } = null!;
    public DbSet<Refund> Refunds { get; set; } = null!;

    protected void OnModelCreating(DbModelBuilder modelBuilder)
    {
        modelBuilder.Conventions.Remove<PluralizingTableNameConvention>();
    }
}

public class PaymentsContext : DbContext
{
    public DbSet<Payment> Payments { get; set; } = null!;
}

public class RefundMap : EntityTypeConfiguration<Refund>
{
    public RefundMap() { ToTable("Refunds", "billing"); }
}

public class Ledger { }

public class LedgerContext : DbContext
{
    public DbSet<Ledger> Ledgers { get; set; } = null!;

    protected void OnModelCreating(DbModelBuilder modelBuilder)
    {
        modelBuilder.Types().Configure(c => c.ToTable("tbl_" + c.ClrType.Name));
    }
}

public class CreditNote : Invoice { }

public class Voucher { }

public class VoucherContext : DbContext
{
    public DbSet<Voucher> Vouchers { get; set; } = null!;

    protected void OnModelCreating(DbModelBuilder modelBuilder)
    {
        modelBuilder.Types().Configure(c => c.ToTable(Registered(c.ClrType).Name, "promo"));
    }

    private static System.Type Registered(System.Type type) => type;
}

public class Gift { }

public class GiftContext : VoucherContext
{
    public DbSet<Gift> Gifts { get; set; } = null!;

    protected new void OnModelCreating(DbModelBuilder modelBuilder)
    {
        modelBuilder.Types().Configure(c => c.Ignore("Legacy"));
    }
}
