export type ErrorCode =
  | 'INVALID_ARGUMENT' | 'UNAUTHORIZED' | 'SCOPE_DENIED' | 'NOT_FOUND' | 'SNAPSHOT_UNAVAILABLE' | 'STALE_INPUT'
  | 'UNSTABLE_WORKTREE' | 'EVIDENCE_UNAVAILABLE' | 'INTEGRITY_FAILURE' | 'BUDGET_EXCEEDED' | 'ADAPTER_UNSUPPORTED'
  | 'TRUST_REQUIRED' | 'DEPENDENCY_UNAVAILABLE' | 'APPROVAL_REQUIRED' | 'APPROVAL_INVALID' | 'CANCELLED' | 'INTERNAL_ERROR'

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
