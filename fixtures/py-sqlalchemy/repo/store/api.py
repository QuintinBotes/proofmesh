from fastapi import APIRouter

from .service import checkout, place

router = APIRouter(prefix="/orders")


@router.post("")
def create_order():
    return place()


@router.post("/{order_id}/checkout")
def checkout_order(order_id: int, urgent: bool = False):
    return checkout(urgent)
