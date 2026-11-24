namespace Orders.Core;

// A same-named Calculate that nothing calls.
public static class Decoy
{
    public static decimal Calculate(decimal amount, int quantity) => amount + quantity;
}
