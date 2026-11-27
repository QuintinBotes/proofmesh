class Totals:
    def __init__(self) -> None:
        self.sum = 0


def add(t: Totals, n: int) -> Totals:
    t.sum += n
    return t
