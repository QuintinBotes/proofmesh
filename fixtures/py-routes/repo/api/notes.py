from fastapi import APIRouter

router = APIRouter(prefix="/notes")


@router.get("")
def list_notes(order_id: int):
    return []


@router.get("/{path:path}")
def note_file(order_id: int, path: str):
    return path
