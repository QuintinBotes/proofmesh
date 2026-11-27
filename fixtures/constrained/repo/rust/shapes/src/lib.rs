pub mod draw;

pub trait Shape {}

#[cfg(test)]
mod tests {
    use super::draw::*;

    fn renders() {
        render(1);
    }
}
