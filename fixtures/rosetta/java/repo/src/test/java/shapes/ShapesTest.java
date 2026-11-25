package shapes;

import org.junit.jupiter.api.Test;

class ShapesTest {
    @Test
    void totalOfTwo() {
        Shapes.total(new Shape[] { new Circle(1), new Square(2) });
    }
}
