from celery import shared_task

from .service import rush


@shared_task
def expedite():
    return rush()
