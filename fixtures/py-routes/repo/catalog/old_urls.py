from django.urls import path

from .views import product_list

urlpatterns = [path("old-products/", product_list)]
