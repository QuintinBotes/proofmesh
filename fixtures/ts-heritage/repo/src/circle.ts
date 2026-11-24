import type { Shape } from './shape'
export class Circle implements Shape {
  constructor(private readonly r: number) {}
  area(): number {
    return 3 * this.r * this.r
  }
}
