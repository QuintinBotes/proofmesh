using Rosetta.Shapes;

namespace Rosetta.Reports;

public static class Report
{
    public static string Make() => $"total {Totals.Total(new IShape[] { new Circle(2) })}";
}
