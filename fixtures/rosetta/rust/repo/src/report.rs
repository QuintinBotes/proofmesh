use crate::shapes::{total, Circle};

pub fn report() -> String {
    format!("total {}", total(&[&Circle { radius: 2.0 }]))
}
