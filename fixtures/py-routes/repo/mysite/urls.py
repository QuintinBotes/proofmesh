from django.urls import include, path, re_path

from . import views

urlpatterns = [
    path("", views.home),
    path("catalog/", include("catalog.urls")),
    re_path(r"^legacy/(?P<code>\w+)/$", views.legacy),
]
