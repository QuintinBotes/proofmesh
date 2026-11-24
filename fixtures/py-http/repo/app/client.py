import httpx

ORDERS = "/api/orders/getAll"


class Shop:
    def __init__(self, base):
        self._base = base

    async def _get(self, path):
        return await httpx.get(self._base + path)

    async def _push(self, path, body):
        return await httpx.post(self._base + path, json=body)

    async def orders(self):
        return await self._get(ORDERS)

    async def order(self, oid):
        return await self._get(f"/api/orders/{oid}?fields=all")

    async def place(self, body):
        return await self._push("/api/orders/add", body)

    def ping(self):
        return httpx.get("https://status.example.com/health")

    def local(self):
        return self._get(self._base)

    async def settle(self, body):
        return await self._push("api/orders/settle", body)

    async def raw(self):
        return await httpx.request("POST", ORDERS)

    def named(self):
        return self._get("ordersOnly")


from fastapi import APIRouter

router = APIRouter()


@router.get("/api/orders/getAll")
async def list_orders():
    return []


router.add_api_route("/api/orders/add", list_orders)
