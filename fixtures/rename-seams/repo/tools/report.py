from tools.totals import Totals, add


def report(rows: list) -> Totals:
    t = Totals()
    for r in rows:
        add(t, r)
    handlers = [add]
    return handlers[0](t, 0)
