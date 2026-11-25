class Shape:
    def area(self) -> float:
        raise NotImplementedError


class Circle(Shape):
    def __init__(self, radius: float) -> None:
        self.radius = radius

    def area(self) -> float:
        return 3 * self.radius * self.radius


class Square(Shape):
    def __init__(self, side: float) -> None:
        self.side = side

    def area(self) -> float:
        return self.side * self.side


def total(shapes: list[Shape]) -> float:
    result = 0.0
    for s in shapes:
        result += s.area()
    return result


def circle_area() -> float:
    return Circle(1).area()
