namespace Shop.Storefront;

public interface ICatalogClient { }

public sealed class CatalogClient : ICatalogClient
{
    public const string Name = "catalog-api";
}

public sealed class ReportsClient { }
