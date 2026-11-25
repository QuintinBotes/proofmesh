pub trait Shape {
    fn area(&self) -> f64;
}

pub struct Circle {
    pub radius: f64,
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        3.0 * self.radius * self.radius
    }
}

pub struct Square {
    pub side: f64,
}

impl Shape for Square {
    fn area(&self) -> f64 {
        self.side * self.side
    }
}

pub fn total(shapes: &[&dyn Shape]) -> f64 {
    let mut sum = 0.0;
    for s in shapes {
        sum += s.area();
    }
    sum
}

pub fn circle_area() -> f64 {
    Circle { radius: 1.0 }.area()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_of_two() {
        assert_eq!(total(&[&Circle { radius: 1.0 }, &Square { side: 2.0 }]), 7.0);
    }
}
