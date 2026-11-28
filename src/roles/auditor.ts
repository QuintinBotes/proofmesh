import { mean } from '../stats'
export function auditorScore(xs: number[]): number {
  return mean(xs) - 1
}
