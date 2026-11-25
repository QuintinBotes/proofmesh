import { total, Circle, Square } from './shapes'

export function totalOfTwo(): number {
  return total([new Circle(1), new Square(2)])
}
