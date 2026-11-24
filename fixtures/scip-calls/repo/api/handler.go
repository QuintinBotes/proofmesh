package api

import (
	"example.com/shop/cart"
	"example.com/shop/pricing"
)

func Handle() string {
	apply(pricing.Total)
	return cart.Cart{}.Checkout()
}

func apply(f func([]int) int) int {
	run := f
	return run(nil)
}
