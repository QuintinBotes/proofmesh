namespace Ops;

public enum Crew { Billing, Search }

[System.AttributeUsage(System.AttributeTargets.Class)]
public sealed class TendedByAttribute(Crew crew) : System.Attribute
{
    public Crew Crew { get; } = crew;
}

public static class Log
{
    public static void Write(string message, Crew? crew = null) { }
}
