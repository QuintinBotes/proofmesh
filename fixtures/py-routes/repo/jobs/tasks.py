from celery import shared_task

from .registry import registry
from .worker import app


@app.task
def rebuild_index():
    return None


@app.task(bind=True, max_retries=3)
def export_orders(self):
    return None


@shared_task
def purge_sessions():
    return None


@shared_task(name="jobs.digest")
def send_digest():
    return None


@registry.task
def not_a_job():
    return None
