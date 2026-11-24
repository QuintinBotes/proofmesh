import { service } from '../src/service'
export function serviceDoubles(): void {
  if (service(1) !== 4) throw new Error('service')
}
