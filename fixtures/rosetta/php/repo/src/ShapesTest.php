<?php

namespace Rosetta;

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/Shapes.php';

class ShapesTest extends TestCase
{
    public function testTotalOfTwo(): void
    {
        $this->assertSame(7.0, total([new Circle(1), new Square(2)]));
    }
}
