namespace Orders.Pricing;

public static class PriceCalculator
{
    public static decimal Calculate(decimal amount, int quantity)
    {
        return Math.Round(amount * quantity, 2);
    }
}
