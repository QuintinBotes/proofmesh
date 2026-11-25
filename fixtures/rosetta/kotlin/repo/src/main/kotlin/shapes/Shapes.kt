package shapes

interface Shape {
    fun area(): Double
}

class Circle(private val radius: Double) : Shape {
    override fun area(): Double = 3 * radius * radius
}

class Square(private val side: Double) : Shape {
    override fun area(): Double = side * side
}

fun total(shapes: List<Shape>): Double {
    var sum = 0.0
    for (s in shapes) {
        sum += s.area()
    }
    return sum
}

fun circleArea(): Double = Circle(1.0).area()
