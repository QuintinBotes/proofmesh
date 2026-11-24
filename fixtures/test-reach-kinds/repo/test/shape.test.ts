import { Unit, type Shape } from '../src/shape'
export function areaThroughInterface(): void {
  const s: Shape = new Unit()
  if (s.area() !== 1) throw new Error('area')
}
