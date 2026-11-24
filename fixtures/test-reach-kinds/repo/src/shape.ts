export interface Shape {
  area(): number
}
export class Unit implements Shape {
  area(): number {
    return 1
  }
}
