import { trip } from './route'

export function tripOfNoStopsIsZero(): void {
  if (trip([]) !== 0) throw new Error('trip of no stops')
}
