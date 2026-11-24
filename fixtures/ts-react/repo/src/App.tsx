import { lazy } from 'react'
import { Theme } from './theme'
import { Button } from './Button'

const LazyCounter = lazy(() => import('./Counter'))

export function App() {
  return (
    <Theme.Provider value="dark">
      <Button label="hello" onClick={() => {}} />
      <LazyCounter />
      <Missing />
    </Theme.Provider>
  )
}
