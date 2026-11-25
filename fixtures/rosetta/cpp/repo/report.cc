#include "shapes.h"

double report() {
    Circle c(2);
    const Shape* shapes[] = {&c};
    return total(shapes, 1);
}
