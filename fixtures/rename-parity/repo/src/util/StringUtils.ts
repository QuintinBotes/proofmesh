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
