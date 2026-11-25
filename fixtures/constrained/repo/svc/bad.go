package main

import "example.com/other"

func undeclared(x string) string {
	return other.Format(x)
}
