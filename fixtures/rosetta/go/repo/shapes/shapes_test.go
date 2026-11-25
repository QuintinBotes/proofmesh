package shapes

import "testing"

func TestTotalOfTwo(t *testing.T) {
	if Total([]Shape{Circle{Radius: 1}, Square{Side: 2}}) != 7 {
		t.Fatal("total")
	}
}
