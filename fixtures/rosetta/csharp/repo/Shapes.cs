namespace Rosetta.Shapes;

public interface IShape
{
    double Area();
}

public class Circle : IShape
{
    private readonly double radius;
    public Circle(double radius) { this.radius = radius; }
    public double Area() => 3 * radius * radius;
}

public class Square : IShape
{
    private readonly double side;
    public Square(double side) { this.side = side; }
    public double Area() => side * side;
}

public static class Totals
{
    public static double Total(IShape[] shapes)
    {
        double sum = 0;
        foreach (var s in shapes) sum += s.Area();
        return sum;
    }

    public static double CircleArea() => new Circle(1).Area();
}
