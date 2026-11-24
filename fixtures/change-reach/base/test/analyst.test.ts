import { analystScore } from '../src/roles/analyst'
export function analystScoreDoubles(): void {
  if (analystScore([1, 3]) !== 4) throw new Error('analystScore')
}
