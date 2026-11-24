from django.views import View
from django.views.generic import TemplateView


def product_list(request):
    return None


class ProductDetail(View):
    def get(self, request, pk):
        return None

    def post(self, request, pk):
        return None

    def helper(self):
        return None


class SearchView(TemplateView):
    template_name = "search.html"
