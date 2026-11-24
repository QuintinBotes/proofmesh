namespace Shop;

public interface IPricing { decimal Price(int sku); }

public sealed class Pricing : IPricing
{
    public decimal Price(int sku) => sku * 2m;
}

public abstract class Component
{
    public IPricing Pricing { get; } = new Pricing();
}

public sealed class Checkout : Component
{
    public decimal Total(int sku) => Pricing.Price(sku);
}

public sealed class Context
{
    public IPricing Pricing { get; } = new Pricing();
}

public static class Report
{
    public static decimal Run(Context context) => context.Pricing.Price(1);
    public static decimal Loose(dynamic d) => d.Price(1, 2);
    public static decimal Missing() => Unknown.Price(3);
    public static void Other() => Unknown.Other();
}
