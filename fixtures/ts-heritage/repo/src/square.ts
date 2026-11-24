import type { Named } from './shape'
export class Square implements Named {
  area(): number {
    return 4
  }
  name(): string {
    return 'square'
  }
}
