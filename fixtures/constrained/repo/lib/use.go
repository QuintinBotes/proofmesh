package lib

import "example.com/lib/internal/secret"

func viaSecret() string {
	return secret.Hidden()
}
