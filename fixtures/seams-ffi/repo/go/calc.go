package calc

// #include "../c/calc.h"
import "C"

func Sum() int {
	return int(C.calc_add(1, 2))
}
