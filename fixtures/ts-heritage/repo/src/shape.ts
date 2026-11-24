export interface Shape {
  area(): number
}
export interface Named extends Shape {
  name(): string
}
