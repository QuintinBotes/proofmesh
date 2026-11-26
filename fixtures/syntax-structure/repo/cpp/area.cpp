#include "shape.hpp"

class Circle : public Shape {
};

double f(Circle& c) { return c.area(); }
