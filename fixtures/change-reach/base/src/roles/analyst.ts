import { mean } from '../stats'
export function analystScore(xs: number[]): number {
  return mean(xs) * 2
}
