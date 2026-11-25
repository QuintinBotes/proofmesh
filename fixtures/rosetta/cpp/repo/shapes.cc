#include "shapes.h"

double total(const Shape* const* shapes, int count) {
    double sum = 0;
    for (int i = 0; i < count; i++) {
        sum += shapes[i]->area();
    }
    return sum;
}

double circleArea() {
    return Circle(1).area();
}
