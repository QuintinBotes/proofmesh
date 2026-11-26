package main

import (
	"fmt"

	v1 "example.com/shop/api/v1"
	"github.com/x/y"
)

func main() {
	user := v1.NewUser("ada")
	fmt.Println(user.Name, y.Do())
}
