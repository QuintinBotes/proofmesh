from pkg.calc import add


def make():
    return add(0, 0)


def test_add():
    assert add(1, 2) == 3
