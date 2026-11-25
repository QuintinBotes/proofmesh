use crate::geo::{Point, Line};

mod geo;

trait Shape {}

trait Named: Shape {}

struct Circle {}

impl Shape for Circle {}

fn area() {
    use std::fmt;
}
