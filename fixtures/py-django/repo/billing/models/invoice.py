from django.db.models import CharField, Model


class Invoice(Model):
    number = CharField(max_length=20)
