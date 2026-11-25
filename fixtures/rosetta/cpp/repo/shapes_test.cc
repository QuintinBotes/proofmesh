#include <gtest/gtest.h>
#include "shapes.h"

TEST(Shapes, TotalOfTwo) {
    Circle c(1);
    Square s(2);
    const Shape* shapes[] = {&c, &s};
    EXPECT_EQ(total(shapes, 2), 7);
}
