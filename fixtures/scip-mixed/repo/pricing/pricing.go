package pricing

// Total sums the prices.
func Total(prices []int) int {
	sum := 0
	for _, p := range prices {
		sum += p
	}
	return sum
}
