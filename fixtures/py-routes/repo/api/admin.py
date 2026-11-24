from fastapi import APIRouter

router = APIRouter(prefix="/admin")


@router.delete("/cache")
def clear_cache():
    return None
