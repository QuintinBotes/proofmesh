// A sentinel (FR079, SC015): it would write a marker file if cargo ran it.
fn main() {
    std::fs::write("MARKER-build-rs", "ran").unwrap();
}
