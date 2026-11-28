export interface Shape {
  area(): number
}

export class Circle implements Shape {
  constructor(private radius: number) {}
  area(): number {
    return 3 * this.radius * this.radius
  }
}

export class Square implements Shape {
  constructor(private side: number) {}
  area(): number {
    return this.side * this.side
  }
}

export function total(shapes: Shape[]): number {
  let sum = 0
  for (const s of shapes) sum += s.area()
  return sum
}

export function circleArea(): number {
  return new Circle(1).area()
}
