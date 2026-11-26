#include <stdio.h>
#include "add.h"

#if defined(EXTRA)
#include "extra.h"
#endif

int total(void) { return add(1, 2); }

int biggest(int a, int b) { return MAX(a, b); }
