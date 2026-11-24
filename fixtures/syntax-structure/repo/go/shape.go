package shape

import (
	"fmt"
	geo "example.com/shop/geo"
)

type Base struct{}

type Shape struct {
	Base
	Origin geo.Point
}
