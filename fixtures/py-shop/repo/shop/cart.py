import json
from .pricing import total
from . import discounts


class Cart:
    def __init__(self, items):
        self.items = items

    def checkout(self):
        amount = total(self.items)
        amount = discounts.apply(amount)
        return self.render(amount)

    def render(self, amount):
        return json.dumps({"amount": amount})

    def dynamic(self, name):
        return getattr(self, name)()
