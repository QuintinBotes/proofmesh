package shapes

type Shape interface {
	Area() float64
}

type Circle struct{ Radius float64 }

func (c Circle) Area() float64 { return 3 * c.Radius * c.Radius }

type Square struct{ Side float64 }

func (s Square) Area() float64 { return s.Side * s.Side }

func Total(shapes []Shape) float64 {
	sum := 0.0
	for _, s := range shapes {
		sum += s.Area()
	}
	return sum
}

func CircleArea() float64 {
	return Circle{Radius: 1}.Area()
}
