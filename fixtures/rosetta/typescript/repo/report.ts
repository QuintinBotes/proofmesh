import { total, Circle } from './shapes'

export function report(): string {
  return `total ${total([new Circle(2)])}`
}
