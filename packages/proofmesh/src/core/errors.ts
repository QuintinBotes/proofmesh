export type ErrorCode =
  | 'INVALID_ARGUMENT' | 'UNAUTHORIZED' | 'SCOPE_DENIED' | 'NOT_FOUND' | 'SNAPSHOT_UNAVAILABLE' | 'STALE_INPUT'
  | 'UNSTABLE_WORKTREE' | 'EVIDENCE_UNAVAILABLE' | 'INTEGRITY_FAILURE' | 'BUDGET_EXCEEDED' | 'ADAPTER_UNSUPPORTED'
  | 'TRUST_REQUIRED' | 'DEPENDENCY_UNAVAILABLE' | 'APPROVAL_REQUIRED' | 'APPROVAL_INVALID' | 'CANCELLED' | 'INDEX_IN_PROGRESS' | 'INTERNAL_ERROR'

export class ProofmeshError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(Object.keys(this.details).length ? { details: this.details } : {}) } }
  }
}

export const asProofmeshError = (e: unknown): ProofmeshError =>
  e instanceof ProofmeshError ? e : new ProofmeshError('INTERNAL_ERROR', e instanceof Error ? e.message : String(e))

/** The message a record may keep: the error's own `stored_message` where it has one, because its message can carry a child's stderr. */
export const storedMessage = (e: unknown): string => {
  const error = asProofmeshError(e)
  return typeof error.details.stored_message === 'string' ? error.details.stored_message : error.message
}
