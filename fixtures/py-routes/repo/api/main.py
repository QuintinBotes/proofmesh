from fastapi import FastAPI

from . import orders

app = FastAPI()
app.include_router(orders.router, prefix="/api")


@app.get("/health")
def health():
    return {"ok": True}
