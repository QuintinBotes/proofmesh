// The Galaxy payload is parsed and its names lowered for search here, off the main thread; the typed arrays go back by
// transfer, so the page copies none of them (FR1452).
import { lowerNames, parseGalaxy } from './galaxyData'

const scope = self as unknown as { onmessage: (e: MessageEvent<ArrayBuffer>) => void; postMessage: (m: unknown, transfer: Transferable[]) => void }
scope.onmessage = ({ data }) => {
  const galaxy = parseGalaxy(data), names = lowerNames(galaxy.names)
  scope.postMessage({ galaxy, names }, [data, names.starts.buffer])
}
