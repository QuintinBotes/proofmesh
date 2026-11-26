from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter()


@router.get("/orders/{order_id}")
def get_order(order_id):
    return {"id": order_id}


@router.get("/orders")
def list_orders():
    return []


app.include_router(router, prefix="/api")
