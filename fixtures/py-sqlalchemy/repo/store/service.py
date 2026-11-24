from .models import Order, RushOrder


def place():
    return Order(kind="order")


def rush():
    return RushOrder(kind="rush")


def checkout(urgent):
    return rush() if urgent else place()


def sessions(dynamo):
    return dynamo.Table("sessions")
