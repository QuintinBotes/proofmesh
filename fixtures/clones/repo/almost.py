def almost(value):
    doubled = value * 2
    return (doubled + value + 2) if (doubled > 10 and doubled < 100) else (value - doubled)
