from flask import Flask

from .shop import bp

app = Flask(__name__)
app.register_blueprint(bp, url_prefix="/shop")


@app.route("/")
def index():
    return "home"


@app.route("/login", methods=["GET", "POST"])
def login():
    return "login"
