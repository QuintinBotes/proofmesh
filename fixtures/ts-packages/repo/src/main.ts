import { greet } from 'greeter'
import { gone } from 'absent-lib'
import { shout } from '@fx/util'

export function run(): void {
  greet('x')
  gone()
  shout('y')
}
