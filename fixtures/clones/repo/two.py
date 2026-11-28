def two(value):
    doubled = value * 2
    return (doubled + value + 1) if (doubled > 10 and doubled < 100) else (value - doubled)
