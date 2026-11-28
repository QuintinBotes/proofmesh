import { add, rarely, registry } from '../src/calc'

export function addsTwoNumbers(): void {
  if (add(1, 2) !== 3) throw new Error('add')
}

export function runsTheRegistry(): void {
  registry['viaRegistry']!()
}

// Skipped in the run the report records, so rarely never runs.
export function rarelyWhenSkipped(): void {
  rarely(true)
}
