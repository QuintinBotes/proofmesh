package report

import (
	"fmt"

	"example.com/rosetta/shapes"
)

func Report() string {
	return fmt.Sprint(shapes.Total([]shapes.Shape{shapes.Circle{Radius: 2}}))
}
