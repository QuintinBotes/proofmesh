namespace Shop.Data;

public class OrderRepository
{
    public Order Load(int id) => Order.Create();
}

public class ShipmentRepository
{
    public Shipment Pending() => Shipment.Create();
}

// Nothing calls this, so the Archive table is reached by nothing.
public class ArchiveRepository
{
    public ArchiveEntry Old() => ArchiveEntry.Create();
}
