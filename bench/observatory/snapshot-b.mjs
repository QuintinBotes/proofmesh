// Snapshot B of the Observatory benchmark (#48): snapshot A of the TypeORM sample plus one commit a reviewer would recognise. It adds
// a file of three functions and a method, removes a function, and changes one method's body, which shifts the lines of the symbols
// below each edit. The stability step (frames.mjs) and Time's Playwright test (e2e/time.spec.ts) both write it.
import fs from 'node:fs'
import path from 'node:path'

/** What the commit does, by name: the symbols it adds (beside the new file's module), removes and changes. */
export const SNAPSHOT_B = {
  file: 'src/util/Retry.ts',
  added: ['src/util/Retry:withRetry', 'src/util/Retry:backoffDelay', 'src/util/Retry:isRetryable', 'src/query-builder/QueryBuilder:QueryBuilder.clearParameters'],
  removed: ['src/util/StringUtils:titleCase'],
  changed: 'src/data-source/DataSource:DataSource.initialize',
}

const RETRY = `/**
 * Runs an operation until it succeeds, waiting longer after each retryable failure.
 */
export async function withRetry<T>(run: () => Promise<T>, attempts: number = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await run()
        } catch (error) {
            if (attempt >= attempts || !isRetryable(error)) throw error
            await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)))
        }
    }
}

/**
 * The wait before the given retry, doubling each time from 100 ms.
 */
export function backoffDelay(attempt: number): number {
    return 100 * 2 ** (attempt - 1)
}

/**
 * Whether a failure is worth another attempt: a dropped or refused connection.
 */
export function isRetryable(error: unknown): boolean {
    const code = (error as { code?: string } | undefined)?.code
    return code === "ECONNRESET" || code === "ECONNREFUSED"
}
`

/** Replaces text that must be there once; a fixture that no longer holds it fails loudly rather than giving another commit. */
function edit(dir, file, from, to) {
  const p = path.join(dir, file), text = fs.readFileSync(p, 'utf8')
  if (text.split(from).length !== 2) throw new Error(`snapshot B: ${file} does not hold the text it edits exactly once`)
  fs.writeFileSync(p, text.replace(from, () => to))
}

/** Removes the text from `from` through the first `through` after it; both must be there, as in edit. */
function cut(dir, file, from, through) {
  const p = path.join(dir, file), text = fs.readFileSync(p, 'utf8'), at = text.indexOf(from), end = at < 0 ? -1 : text.indexOf(through, at)
  if (at < 0 || end < 0) throw new Error(`snapshot B: ${file} does not hold the text it removes`)
  fs.writeFileSync(p, text.slice(0, at) + text.slice(end + through.length))
}

/** Writes the commit's changes into a copy of the TypeORM sample at dir; committing and indexing are the caller's. */
export function writeSnapshotB(dir) {
  fs.writeFileSync(path.join(dir, SNAPSHOT_B.file), RETRY)
  edit(dir, 'src/query-builder/QueryBuilder.ts', '    protected createParameter(value: any): string {', '    /**\n     * Removes every parameter set so far.\n     */\n    clearParameters(): this {\n        this.expressionMap.parameters = {}\n        return this\n    }\n\n    protected createParameter(value: any): string {')
  // titleCase with its doc comment, whose link the leak scan would flag were it copied here.
  cut(dir, 'src/util/StringUtils.ts', '/**\n * Converts string into Title Case.', 'txt.substr(1).toLowerCase(),\n    )\n}\n\n')
  edit(dir, 'src/data-source/DataSource.ts', 'import { ObjectLiteral } from "../common/ObjectLiteral"\n', 'import { ObjectLiteral } from "../common/ObjectLiteral"\nimport { withRetry } from "../util/Retry"\n')
  edit(dir, 'src/data-source/DataSource.ts', '        await this.driver.connect()\n', '        await withRetry(() => this.driver.connect())\n')
}
