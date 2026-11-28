export function third(value: number) {
  const doubled = value * 2
  return doubled > 10 ? doubled + value + 1 : value - doubled
}
