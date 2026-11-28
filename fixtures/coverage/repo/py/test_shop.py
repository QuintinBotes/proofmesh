import shop


def test_total():
    assert getattr(shop, "total")([1, 2]) == 3
