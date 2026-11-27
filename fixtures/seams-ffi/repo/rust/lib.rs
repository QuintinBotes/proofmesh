extern "C" {
    fn calc_add(a: i32, b: i32) -> i32;
}

fn sum() -> i32 {
    unsafe { calc_add(1, 2) }
}
