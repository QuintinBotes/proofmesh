from django.urls import path

from .views import ProductDetail, SearchView, product_list

urlpatterns = [
    path("products/", product_list),
    path("products/<int:pk>/", ProductDetail.as_view()),
]

urlpatterns += [
    path("search/", SearchView.as_view()),
]
