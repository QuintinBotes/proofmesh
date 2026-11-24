import { core } from './core'
export function service(n: number): number {
  return core(n) * 2
}
