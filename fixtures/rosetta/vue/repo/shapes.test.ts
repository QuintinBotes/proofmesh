import { mount } from '@vue/test-utils'
import { total, Circle, Square } from './shapes'
import Report from './Report.vue'

export function totalOfTwo(): number {
  return total([new Circle(1), new Square(2)])
}

export function reportRenders(): void {
  mount(Report)
}
