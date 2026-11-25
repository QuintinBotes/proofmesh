package shapes;

public class Shapes {
    public static double total(Shape[] shapes) {
        double sum = 0;
        for (Shape s : shapes) {
            sum += s.area();
        }
        return sum;
    }

    public static double circleArea() {
        return new Circle(1).area();
    }
}
