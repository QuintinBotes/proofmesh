from django.views import View

from shop.models import Customer, GiftOrder, Order


def register(name):
    return Customer(name=name)


def send_gift(customer, message):
    return GiftOrder(customer=customer, message=message)


def recent():
    return Order.objects.order_by("-created")[:10]


class GiftView(View):
    def post(self, request):
        return send_gift(request.user, request.POST["message"])
