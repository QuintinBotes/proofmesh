import { useContext } from 'react'
import { Theme } from './theme'

export function Button(props: { label: string; onClick: () => void }) {
  const theme = useContext(Theme)
  return <button className={theme} onClick={props.onClick}>{props.label}</button>
}
