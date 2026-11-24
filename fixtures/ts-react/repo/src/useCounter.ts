import { useState } from 'react'

export function useCounter(start: number): [number, () => void] {
  const [count, setCount] = useState(start)
  return [count, () => setCount(count + 1)]
}
