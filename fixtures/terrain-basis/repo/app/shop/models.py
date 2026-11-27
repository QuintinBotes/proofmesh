from django.db import models

from app.billing.tables import charge


class Order(models.Model):
    total = models.IntegerField()


def place(amount):
    return charge(amount)
