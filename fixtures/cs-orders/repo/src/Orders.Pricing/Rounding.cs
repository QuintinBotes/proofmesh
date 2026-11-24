namespace Orders.Pricing;

public static class Rounding
{
    // Ledger is declared nowhere, and this project lacks no package, so the name is unknown rather than missing.
    public static void Record(decimal amount) => Ledger.Post(amount);
}
