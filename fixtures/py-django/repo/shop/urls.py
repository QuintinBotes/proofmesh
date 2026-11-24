from django.urls import path

from . import views

urlpatterns = [
    path("customers/", views.register),
    path("gifts/", views.GiftView.as_view()),
]
