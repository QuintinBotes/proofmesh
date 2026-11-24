import { service } from '../src/service'

export function serviceAddsOne(): boolean {
  return service() === 2
}
