import { useCounter } from './useCounter'
import { Button } from './Button'

export default function Counter() {
  const [count, increment] = useCounter(0)
  return <Button label={String(count)} onClick={increment} />
}
