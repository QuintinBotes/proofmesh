/** A count and its noun, singular for exactly one: "1 symbol", "1,234 symbols" (FR1210). */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en')} ${n === 1 ? one : many}`
