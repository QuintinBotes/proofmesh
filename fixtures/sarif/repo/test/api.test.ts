import { handle } from '../src/api'

export function handlesAnId(): boolean {
  return handle('1') == 'ran 1'
}
