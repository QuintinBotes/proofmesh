#include "../lib/util.h"
#include "local.h"
#include <stdio.h>
#include "util.h"

static int helper(int x) { return x; }

int main(void) {
    helper(1);
    add(1, 2);
    hidden(3);
    declared_only();
    printf("x");
    struct ops o;
    o.run(1);
    return 0;
}
