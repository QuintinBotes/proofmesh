export class Point {
  constructor(public x: number, public y: number) {}

  norm(): number {
    return Math.hypot(this.x, this.y)
  }
}
