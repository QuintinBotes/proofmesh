import { render } from '@testing-library/svelte'
import { total, Circle, Square } from './shapes'
import Report from './Report.svelte'

export function totalOfTwo(): number {
  return total([new Circle(1), new Square(2)])
}

export function reportRenders(): void {
  render(Report)
}
