import { analystScore } from './roles/analyst'
export function report(xs: number[]): string {
  return `score ${analystScore(xs)}`
}
