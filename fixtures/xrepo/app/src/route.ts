import { distance } from '@fx/geo'
import { Pin } from './pin'

export function leg(a: Pin, b: Pin): number {
  return distance(a, b)
}

export function trip(stops: Pin[]): number {
  let total = 0
  for (let i = 1; i < stops.length; i++) total += distance(stops[i - 1]!, stops[i]!)
  return total
}

export function start(): Pin {
  return new Pin(0, 0)
}
