package main

import (
	"bytes"

	"example.com/lib"
)

func collide(buf *bytes.Buffer, it lib.Item) {
	buf.Write(nil)
	it.Write()
}
