from sqlalchemy import Column, ForeignKey, Integer, String, Table

from .db import Base, metadata

order_lines = Table(
    "order_lines",
    metadata,
    Column("order_id", ForeignKey("orders.id")),
    Column("sku", String),
)


class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)
    kind = Column(String)
    __mapper_args__ = {"polymorphic_on": kind, "polymorphic_identity": "order"}


class RushOrder(Order):
    __mapper_args__ = {"polymorphic_identity": "rush"}


class Refund(Order):
    __tablename__ = "refunds"
    id = Column(ForeignKey("orders.id"), primary_key=True)
    __mapper_args__ = {"polymorphic_identity": "refund"}


class OrderLine(Base):
    __table__ = order_lines


def shard():
    return "audit_2026"


class AuditEntry(Base):
    __tablename__ = shard()
    id = Column(Integer, primary_key=True)
