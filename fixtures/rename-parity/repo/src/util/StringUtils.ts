/** first_name to firstName. */
export function camelCase(text: string): string {
    return text.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())
}

/** Every key of a row in camel case. */
export function camelKeys(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(row)) out[camelCase(key)] = row[key]
    return out
}

export const casing = { camelCase }

/** a_b_c to a[b[c]]. */
export function bracketed(text: string): string {
    return nest(text)
}

/** Calls itself inside a template; its option and a key share its name and are no use of it. */
function nest(
    text: string,
    { nest: depth }: { nest: number } = { nest: 0 },
): string {
    const at = text.indexOf("_")
    if (at < 0) return text
    const inner = { nest: depth + 1 }
    return `${text.slice(0, at)}[${nest(text.slice(at + 1), inner)}]`
}
