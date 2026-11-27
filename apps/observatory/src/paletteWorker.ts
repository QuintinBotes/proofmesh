// The palette's name index lives in this worker, so building it and answering each query never block the page (FR1142).
import { buildIndex, searchIndex } from './paletteIndex'

type Message = { names: string[]; files: string[] } | { id: number; query: string }
const scope = self as unknown as { onmessage: (e: MessageEvent<Message>) => void; postMessage: (m: unknown) => void }
let index = buildIndex([], [])
scope.onmessage = ({ data }) => {
  if ('names' in data) index = buildIndex(data.names, data.files)
  else scope.postMessage({ id: data.id, query: data.query, ...searchIndex(index, data.query) })
}
