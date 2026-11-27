# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code is copied: every file was written for this fixture, and the names (calc, calc_add, Native) are invented.

One repository whose C functions are called from five other languages through their foreign-function interfaces. It exercises the FFI seams of FR460 to FR467:

- `java/src/main/java/com/acme/Native.java` and `c/jni.c`: a Java `native` method and the JNI function that implements it (rule `jni`).
- `c/calc.h` and `c/calc.c`: `calc_add`, declared in a header and defined once.
- `cs/Calc.cs`: a `[DllImport("calc")]` declaration of `calc_add` (rule `pinvoke`).
- `go/calc.go`: a cgo preamble and a call of `C.calc_add` in `Sum` (rule `cgo`).
- `rust/lib.rs`: an `extern "C"` block declaring `calc_add` and a call of it in `sum` (rule `rust_extern_c`).
- `py/ext.c` and `py/use.py`: a C extension module `calc` whose `PyMethodDef` table registers `add` as `py_add`, and a Python call of `calc.add` (rule `python_c_extension`).

The expected facts are written by hand in `packages/proofmesh/test/seams-ffi.test.ts`.
