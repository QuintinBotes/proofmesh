import { mean } from '../stats'
export function managerScore(xs: number[]): number {
  return Math.round(mean(xs))
}
