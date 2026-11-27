#include "shape.hpp"

namespace geo {
int area(int w) { return w; }
int Shape::size() { return area(1); }
int Shape::scaled() { return size() * 2; }
Shape Shape::make() { return Shape(); }
}
