pub fn render(x: i32) {
    crate_only();
}

fn secret() {}

pub(crate) fn crate_only() {}
