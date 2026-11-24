from tools.cache import get

from .board import Board

menu = Board()


@menu.get("/specials")
def specials():
    return []


@get("/cached")
def cached():
    return []
