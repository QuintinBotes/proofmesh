package main

import (
	"example.com/lib/testdata/fix"
	"example.com/lib/vendor/v"
)

func ignored(x string) string {
	return fix.Format(x) + v.Format(x)
}
