import type { Shape } from './shape'
export abstract class Base implements Shape {
  abstract area(): number
}
export class Tile extends Base {
  area(): number {
    return 1
  }
}
