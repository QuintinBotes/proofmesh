package cart

type Cart struct {
	Items []int
}

func (c Cart) Checkout() string {
	return "done"
}

func (c *Cart) Add(p int) {
	c.Items = append(c.Items, p)
}

func New() Cart {
	return Cart{}
}
