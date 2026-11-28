// The renderers' views, each loaded on first use (FR1451): App and the Claims view both draw the Terrain from here.
import { createElement, useEffect, useState, type ComponentProps, type ComponentType } from 'react'

/**
 * A renderer's view, whose library loads on first use, so the first screen fetches only its own (FR1451); it draws nothing until
 * the module is in, then the view itself. Not React.lazy: its Suspense holds a view back for about 300 ms after its module arrives.
 */
function lazyView<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> & { preload: () => Promise<unknown> } {
  let loaded: ComponentType<P> | undefined, pending: Promise<unknown> | undefined
  const preload = () => (pending ??= load().then((c) => { loaded = c }))
  function View(props: P) {
    const [, arrived] = useState(false)
    useEffect(() => { if (!loaded) void preload().then(() => arrived(true)) }, [])
    return loaded ? createElement(loaded, props) : null
  }
  return Object.assign(View, { preload })
}
export const Terrain = lazyView(() => import('./Terrain').then((m) => { m.warmRenderer(); return m.Terrain }))
/** Keep an opened snapshot map at its camera position while its Diff table occupies the same space. */
export function SnapshotTerrain({ active, ...props }: ComponentProps<typeof Terrain> & { active: boolean }) {
  const [visited, setVisited] = useState(active)
  useEffect(() => { if (active) setVisited(true) }, [active])
  if (!active && !visited) return null
  // Keep the canvas dimensions so Sigma's resize observer does not reset the viewport.
  return <div inert={!active} style={{ visibility: active ? undefined : 'hidden' }}><Terrain {...props} /></div>
}
export const GraphView = lazyView(() => import('./GraphView').then((m) => m.GraphView))
