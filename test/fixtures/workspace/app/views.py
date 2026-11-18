from django.shortcuts import render
from django.views import View


def index(request):
    return render(request, "app/index.html")


class ArticleView(View):
    template_name = "app/article.html"

    def get(self, request):
        return "get"

    def post(self, request):
        return "post"
