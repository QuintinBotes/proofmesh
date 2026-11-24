import type { Shape } from './shape'
export function report(s: Shape): string {
  return `area ${s.area()}`
}
