import { untested } from '../src/core'
import { LIMIT } from '../src/consts'
export function limitIsTen(): void {
  if (LIMIT !== 10) throw new Error('limit')
}
