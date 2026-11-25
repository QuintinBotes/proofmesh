from shapes import Circle, Square, total


def test_total_of_two() -> None:
    assert total([Circle(1), Square(2)]) == 7
