export async function loadB(): Promise<number> {
  const m = await import('./b.js')
  return m.b
}
