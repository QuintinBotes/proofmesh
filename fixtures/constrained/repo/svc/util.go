package main

import "example.com/lib"

func helper() string {
	return "h"
}

type Base struct{}

type Wrapper struct {
	Base
	lib.Item
}
