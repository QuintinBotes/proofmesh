package main

//go:generate sh -c "touch \"$HOME/proofmesh-sentinel-ran\""

/*
#cgo CFLAGS: -DPROOFMESH_SENTINEL=1
#include <stdlib.h>
*/
import "C"

func main() { println(Greeting("x")) }
