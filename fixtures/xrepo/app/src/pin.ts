import { Point } from '@fx/geo'

export class Pin extends Point {
  label(): string {
    return `${this.x},${this.y}`
  }
}
