import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

/** The height every row of a virtual table is drawn at, in px (styles.css .virtual). */
export const ROW_PX = 28

/** The rows from first to last (exclusive) a scroll position shows, with a screen of rows either side to scroll into. */
export function rowWindow(count: number, scrollTop: number, height: number, row = ROW_PX): [number, number] {
  const screen = Math.ceil(height / row)
  return [Math.max(0, Math.floor(scrollTop / row) - screen), Math.min(count, Math.ceil((scrollTop + height) / row) + screen)]
}

/**
 * A table that draws only the rows near its scroll position, so a table of any length keeps a few hundred rows in the page and
 * never cuts one off (FR1454); rows of equal height stand in for the rest, so the scroll bar is as long as every row.
 */
export function VirtualTable({ count, caption, head, row, columns }: { count: number; caption: ReactNode; head?: ReactNode; row: (i: number) => ReactElement<object>; columns: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 800 })
  useLayoutEffect(() => { if (box.current) setView({ top: box.current.scrollTop, height: box.current.clientHeight || 800 }) }, [count])
  const [first, last] = rowWindow(count, view.top, view.height)
  const spacer = (rows: number) => <tr aria-hidden="true" className="spacer" style={{ height: rows * ROW_PX }}><td colSpan={columns} /></tr>
  return (
    <div ref={box} className="virtual" onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
      <table aria-rowcount={count + 1}>
        <caption>{caption}</caption>
        {head}
        <tbody>
          {first > 0 && spacer(first)}
          {/* Row 1 is the header, so row i of the list is row i + 2 of the table. */}
          {Array.from({ length: last - first }, (_, k) => cloneElement(row(first + k), { 'aria-rowindex': first + k + 2 } as object))}
          {last < count && spacer(count - last)}
        </tbody>
      </table>
    </div>
  )
}
