using Rosetta.Shapes;
using Xunit;

namespace Rosetta.Tests;

public class ShapesTests
{
    [Fact]
    public void TotalOfTwo() => Totals.Total(new IShape[] { new Circle(1), new Square(2) });
}
