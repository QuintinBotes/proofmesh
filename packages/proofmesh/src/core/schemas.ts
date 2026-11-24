import fs from 'node:fs'
import path from 'node:path'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { schemasDir } from './paths.js'

// date-time is checked by the readers that need it; ajv would only warn that the format is unknown.
const ajv = new Ajv2020({ allErrors: false, strict: false, formats: { 'date-time': true } })
// Messages from an adapter of a newer 1.x minor version may carry fields this core does not know; they are removed, not refused (A22).
const tolerant = new Ajv2020({ allErrors: false, strict: false, removeAdditional: true, formats: { 'date-time': true } })
const cache = new Map<string, ValidateFunction>(), tolerantCache = new Map<string, ValidateFunction>()

/** The schema_version the envelope and bundle manifest schemas fix. Kept here, not beside their writers, so the contract manifest can cite them without an import cycle. */
export const ENVELOPE_VERSION = '0.1'
export const BUNDLE_FORMAT_VERSION = '0.1'

export const loadSchema = (relative: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(schemasDir(), relative), 'utf8')) as Record<string, unknown>

export function validator(relative: string): ValidateFunction {
  let v = cache.get(relative)
  if (!v) {
    v = ajv.compile(loadSchema(relative))
    cache.set(relative, v)
  }
  return v
}

/** Validates a message from an adapter, first removing the optional fields a newer minor version may have added. */
export function checkAdapterMessage(relative: string, value: unknown): string | undefined {
  let v = tolerantCache.get(relative)
  if (!v) { v = tolerant.compile(loadSchema(relative)); tolerantCache.set(relative, v) }
  if (v(value)) return undefined
  const e = v.errors?.[0]
  return e ? `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}` : 'is invalid'
}

export function check(relative: string, value: unknown): string | undefined {
  const v = validator(relative)
  if (v(value)) return undefined
  const e = v.errors?.[0]
  return e ? `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}` : 'is invalid'
}

export const readSql = (relative: string): string => fs.readFileSync(path.join(schemasDir(), relative), 'utf8')
