from flask import Blueprint

METHODS = ["GET", "POST"]

bp = Blueprint("shop", __name__, url_prefix="/store")


@bp.route("/items/<int:item_id>")
def item(item_id):
    return str(item_id)


@bp.get("/items")
def items():
    return []


@bp.route("/files/<path:name>")
def files(name):
    return name


@bp.route("/sync", methods=METHODS)
def sync():
    return ""
