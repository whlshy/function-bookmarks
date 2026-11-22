use std::fmt;

/// 文件註解 fn not_me() {}
pub struct Point<T> {
    x: T,
    y: T,
}

pub struct Meters(f64);

impl<T: Copy> Point<T> {
    pub fn new(x: T, y: T) -> Self {
        Point { x, y }
    }

    pub(crate) fn first<'a>(&'a self, other: &'a str) -> &'a T {
        let c = '{';
        &self.x
    }
}

impl<T: fmt::Display> fmt::Display for Point<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, r#"({}, {}) fn raw() {{"#, self.x, self.y)
    }
}

pub trait Shape {
    fn area(&self) -> f64;
    fn name(&self) -> String {
        String::from("shape")
    }
}

pub enum Command {
    Quit,
    Move { x: i32 },
}

mod tests {
    /* outer /* nested */ fn hidden() {} */
    #[test]
    fn it_works() {
        assert_eq!(2 + 2, 4);
    }
}

pub async unsafe fn run<F>(f: F)
where
    F: Fn() -> i32,
{
    f();
}

macro_rules! square {
    ($x:expr) => { $x * $x };
}
