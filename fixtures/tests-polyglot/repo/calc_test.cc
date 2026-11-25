#include <gtest/gtest.h>

int make() {
  return add(0, 0);
}

TEST(Calc, Adds) {
  EXPECT_EQ(add(1, 2), 3);
}
