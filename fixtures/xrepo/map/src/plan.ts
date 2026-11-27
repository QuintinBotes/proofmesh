import { trip } from 'fx-app'

export function plan(): number {
  return trip([])
}

export function tour(): number {
  return plan() * 2
}
