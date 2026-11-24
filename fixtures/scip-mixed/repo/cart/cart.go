package cart

import (
	"fmt"

	"example.com/shop/legacy"
	"example.com/shop/pricing"
)

type Cart struct {
	Prices []int
}

func (c Cart) Checkout() string {
	return fmt.Sprint(pricing.Total(c.Prices))
}

func Legacy() int { return legacy.Old() }
