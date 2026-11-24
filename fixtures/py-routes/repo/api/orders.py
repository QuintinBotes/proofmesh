from fastapi import APIRouter

from .notes import router as notes

BASE = "/export"

router = APIRouter(prefix="/orders")
router.include_router(notes, prefix="/{order_id}")


@router.get("/{order_id}")
def get_order(order_id: int):
    return {"id": order_id}


@router.post("/add")
def add_order():
    return {}


@router.api_route("/{order_id}/cancel", methods=["POST", "DELETE"])
def cancel_order(order_id: int):
    return {}


@router.get(BASE + "/all")
def export_orders():
    return []
