import { readFileSync } from 'node:fs'
import path from 'path'
export const readHere = (f: string): string => readFileSync(path.join('.', f), 'utf8')
