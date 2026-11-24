export function mean(xs: number[]): number {
  return xs.length < 2 ? (xs[0] ?? 0) : mean([xs.reduce((a, b) => a + b, 0) / xs.length])
}

export function spread(xs: number[]): number {
  return Math.max(...xs) + Math.min(...xs)
}
