mod util;
use shapes::draw::render;
use crate::util::helper as h;
use shapes::draw;

fn main() {
    helper();
    util::helper();
    h();
    render(1);
    draw::render(2);
    shapes::draw::secret();
    shapes::draw::crate_only();
    other::thing();
    let w = Widget::new();
    w.paint();
}

fn helper() {}

struct Widget;

impl Widget {
    pub fn new() -> Self {
        Self::make()
    }
    fn make() -> Self {
        Widget
    }
    pub fn paint(&self) {
        self.size();
    }
    fn size(&self) {}
}

impl shapes::Shape for Widget {}

fn scoped() {
    use shapes::draw::render as drawn;
    drawn(1);
}

fn outside() {
    drawn(2);
}
