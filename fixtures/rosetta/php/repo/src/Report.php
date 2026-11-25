<?php

namespace Rosetta;

require_once __DIR__ . '/Shapes.php';

function report(): string
{
    return 'total ' . total([new Circle(2)]);
}
