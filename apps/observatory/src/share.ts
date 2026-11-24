/** A4: a share is shown with its percentage only when at least 20 sites back it, so a small sample never reads as a rate. */
export const MIN_SITES = 20
export function share(count: number, of: number): string {
  const n = count.toLocaleString('en')
  return of >= MIN_SITES ? `${n} (${Math.round((100 * count) / of)}%)` : n
}
