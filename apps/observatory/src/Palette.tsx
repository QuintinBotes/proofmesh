import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { shortName, type GalaxyData } from './galaxyData'
import { LIMIT } from './paletteIndex'
import { visible } from './visible'

/** A palette command; key is its single-key shortcut, when it has one (FR1144). */
export type Command = { label: string; key?: string; run: () => void }
type Answer = { id: number; query: string; items: number[]; total: number }

let worker: Worker | null = null, indexed: GalaxyData | null = null, asked = 0
/** One worker for the page, handed each snapshot's names once, when the palette first needs them (FR1142). */
function workerFor(g: GalaxyData): Worker {
  worker ??= new Worker(new URL('./paletteWorker.ts', import.meta.url), { type: 'module' })
  if (indexed !== g) { indexed = g; worker.postMessage({ names: g.names, files: g.files }) }
  return worker
}

const count = (n: number) => `${n.toLocaleString('en')} ${n === 1 ? 'symbol or file matches' : 'symbols and files match'}`

/**
 * The command palette (FR1140): a dialog whose combobox filters commands at once and asks the worker for symbols and files.
 * galaxy is null while the names load, or for good when no repository is open (noRepository).
 */
export function Palette({ commands, galaxy, noRepository, onSymbol, onFile, onClose }: {
  commands: Command[]; galaxy: GalaxyData | null; noRepository: boolean; onSymbol: (index: number) => void; onFile: (path: string) => void; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  // Queries the worker has not answered yet, counted so the first answer back does not clear the busy state of a later one (FR640).
  const [inFlight, setInFlight] = useState(0)
  const since = useRef(asked)
  // Enter pressed before the answer to what was typed arrived: choose once it does.
  const enter = useRef(false)
  const q = query.trim()
  // Where focus was before the field took it (on first render, ahead of autoFocus); closing returns it there.
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => () => { if (opener?.isConnected) opener.focus() }, [opener])
  useEffect(() => {
    if (!galaxy) return
    setAnswer(null)
    const onMessage = ({ data }: MessageEvent<Answer>) => {
      if (data.id <= since.current) return
      setInFlight((n) => n - 1)
      if (data.id === asked) setAnswer(data)
    }
    const w = workerFor(galaxy)
    w.addEventListener('message', onMessage)
    return () => w.removeEventListener('message', onMessage)
  }, [galaxy])
  useEffect(() => {
    setActive(0)
    if (!galaxy || q.length < 2) return
    setInFlight((n) => n + 1)
    workerFor(galaxy).postMessage({ id: ++asked, query: q })
  }, [galaxy, q])

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const options: Array<{ run: () => void; body: ReactNode }> = commands
    .filter((c) => terms.every((t) => c.label.toLowerCase().includes(t)))
    .map((c) => ({ run: c.run, body: <><span>{visible(c.label)}</span>{c.key && <kbd>{c.key}</kbd>}</> }))
  const fresh = galaxy && answer && answer.query === q && q.length >= 2 ? answer : null
  for (const i of fresh?.items ?? []) {
    options.push(i < galaxy!.n
      ? { run: () => onSymbol(i), body: <><b>{visible(shortName(galaxy!.names[i]!))}</b> <span className="dim">{galaxy!.kinds[galaxy!.kind[i]!]} · {visible(galaxy!.names[i]!)}</span></> }
      : { run: () => onFile(galaxy!.files[i - galaxy!.n]!), body: <><b>{visible(galaxy!.files[i - galaxy!.n]!.split('/').pop()!)}</b> <span className="dim">file · {visible(galaxy!.files[i - galaxy!.n]!)}</span></> })
  }
  const waiting = q.length >= 2 && !fresh && !(noRepository && !galaxy)
  const choose = (i: number) => { const o = options[i]; if (!o) return; onClose(); o.run() }
  useEffect(() => { if (enter.current && fresh) { enter.current = false; choose(active) } })

  const note = q.length === 0 ? 'Control+K, ⌘K or / opens this palette, ? lists every key, Escape closes it. Type two characters to search symbols and files.'
    : q.length < 2 ? 'Type at least two characters to search symbols and files.'
    : !galaxy ? (noRepository ? 'No repository is open, so only commands are listed.' : 'Loading names…')
    : !fresh ? 'Searching…'
    : fresh.total === 0 ? `No symbol or file matches “${visible(q)}”.`
    : fresh.total > LIMIT ? `${count(fresh.total)}; the first ${LIMIT} are listed, ${(fresh.total - LIMIT).toLocaleString('en')} more. Type more to narrow them.`
    : `${count(fresh.total)}.`
  useEffect(() => { document.getElementById(`palette-option-${active}`)?.scrollIntoView({ block: 'nearest' }) }, [active])

  const onKeyDown = (e: KeyboardEvent) => {
    const n = options.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n) }
    else if (e.key === 'Enter') { e.preventDefault(); if (waiting) enter.current = true; else choose(active) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    // The dialog is modal and the field is its only control, so Tab keeps focus in it.
    else if (e.key === 'Tab') e.preventDefault()
  }
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input role="combobox" aria-label="Find a symbol, file or command" aria-autocomplete="list" aria-expanded={options.length > 0}
          aria-controls={options.length ? 'palette-options' : undefined} aria-activedescendant={options.length ? `palette-option-${active}` : undefined}
          autoFocus autoComplete="off" spellCheck={false} placeholder="A name, a file or a command" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} />
        <p className="dim" role="status">{note}</p>
        {options.length > 0 && (
          <ul id="palette-options" role="listbox" aria-label="Results" aria-busy={inFlight > 0}>
            {options.map((o, i) => (
              <li key={i} id={`palette-option-${i}`} role="option" aria-selected={i === active} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(i)}>{o.body}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
