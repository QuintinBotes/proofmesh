package main

import "example.com/lib"

func run(x string, it lib.Item) string {
	_ = lib.format(x)
	_ = it.Total()
	it.reset()
	return lib.Format(x) + helper()
}

func shadowed() string {
	helper := func() string { return "" }
	return helper()
}

func paramNamedLib(lib lib.Item) {
	lib.Format("x")
}
