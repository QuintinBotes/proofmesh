from django.db import models


class TimeStamped(models.Model):
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


class Customer(TimeStamped):
    name = models.CharField(max_length=80)


class Order(TimeStamped):
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE)

    class Meta:
        db_table = "sales_orders"


class OpenOrder(Order):
    class Meta:
        proxy = True


class GiftOrder(Order):
    message = models.TextField()


class Tag(models.Model):
    label = models.CharField(max_length=20)

    class Meta:
        app_label = "catalog"


class Choices:
    class Meta:
        db_table = "not_a_table"
