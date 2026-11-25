package report;

import shapes.Circle;
import shapes.Shapes;
import shapes.Shape;

public class Report {
    public static String report() {
        return "total " + Shapes.total(new Shape[] { new Circle(2) });
    }
}
