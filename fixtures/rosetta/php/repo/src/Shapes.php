<?php

namespace Rosetta;

interface Shape
{
    public function area(): float;
}

class Circle implements Shape
{
    public function __construct(private float $radius) {}

    public function area(): float
    {
        return 3 * $this->radius * $this->radius;
    }
}

class Square implements Shape
{
    public function __construct(private float $side) {}

    public function area(): float
    {
        return $this->side * $this->side;
    }
}

function total(array $shapes): float
{
    $sum = 0.0;
    foreach ($shapes as $s) {
        $sum += $s->area();
    }
    return $sum;
}

function circleArea(): float
{
    return (new Circle(1))->area();
}
