pub struct Counter {
    n: u32,
}

impl Counter {
    pub fn bump(&mut self) {
        self.n += 1;
    }
}

impl Default for Counter {
    fn default() -> Self {
        Counter { n: 0 }
    }
}

pub struct Timer {
    ticks: u32,
}

impl Timer {
    pub fn bump(&mut self) {
        self.ticks += 1;
    }
}
