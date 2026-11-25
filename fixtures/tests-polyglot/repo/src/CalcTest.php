<?php

use PHPUnit\Framework\TestCase;

class CalcTest extends TestCase
{
    public function testAdd(): void
    {
        $this->assertSame(3, (new Calc())->add(1, 2));
    }

    public function make(): int
    {
        return (new Calc())->add(0, 0);
    }
}
