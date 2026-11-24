package com.acme.shapes;

enum Kind implements Named {
  ROUND;

  enum Size implements Shape { BIG }
}

record Pair(int a) implements Shape {}
