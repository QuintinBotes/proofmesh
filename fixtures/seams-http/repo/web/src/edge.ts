declare const base: string

export const unknownCall = () => fetch('/api/unknown')
export const retireLegacy = () => fetch('/api/legacy', { method: 'POST' })
export const viaBase = () => fetch(base + '/orders')
