import requests


def apply(amount):
    return amount * 0.9


def fetch_rate():
    return requests.get("https://rates.example.com").json()
