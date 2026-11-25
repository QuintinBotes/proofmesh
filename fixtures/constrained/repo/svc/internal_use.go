package main

import "example.com/lib/internal/secret"

func peek() string {
	return secret.Hidden()
}
