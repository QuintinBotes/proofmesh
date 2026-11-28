import { mean } from '../stats'
export function managerScore(xs: number[]): number {
  return xs.length === 0 ? 0 : Math.round(mean(xs))
}
