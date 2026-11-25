#pragma once

struct Shape {
    virtual ~Shape() = default;
    virtual double area() const = 0;
};

struct Circle : Shape {
    explicit Circle(double radius) : radius_(radius) {}
    double area() const override { return 3 * radius_ * radius_; }
    double radius_;
};

struct Square : Shape {
    explicit Square(double side) : side_(side) {}
    double area() const override { return side_ * side_; }
    double side_;
};

double total(const Shape* const* shapes, int count);
double circleArea();
