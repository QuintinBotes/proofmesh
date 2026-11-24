import { ProofmeshError } from '../core/errors.js'
import { Catalog } from '../meshstore/catalog.js'
import { runVerification } from '../verification/launcher.js'
import { approver, ENABLED } from '../verification/prepare.js'

const USAGE = 'usage: proofmesh verification enable | disable | approve <vr_id> | run <vr_id> [--container IMAGE]'

/** Only a person runs these: enabling, approving and launching are trust decisions (D07, FR044, FR045). */
export async function runVerificationCommand(dataDir: string, rest: string[]): Promise<number> {
  const [cmd, id] = rest
  if (cmd === 'run' && id) {
    const at = rest.indexOf('--container')
    const v = await runVerification(dataDir, id, at >= 0 ? { container: rest[at + 1] } : {})
    const r = v.record!.record as { exit_code: number | null; timed_out: boolean; truncated: boolean; sandbox: string }
    console.log(`verification ${v.id} ${v.state}: exit ${r.exit_code ?? 'none'}${r.timed_out ? ', timed out' : ''}${r.truncated ? ', output truncated' : ''}; sandbox ${r.sandbox}; output in ${dataDir}/verification/${v.id}/output.log`)
    if (r.sandbox === 'process') console.log('A plain process: time and output were limited; network and filesystem policy were not enforced. Use --container IMAGE for isolation.')
    return v.state === 'finished' ? 0 : 1
  }
  const catalog = Catalog.open(dataDir)
  try {
    if (cmd === 'enable' || cmd === 'disable') {
      catalog.setSetting(ENABLED, cmd === 'enable' ? 'on' : 'off')
      console.log(cmd === 'enable' ? 'verification execution enabled: agents may prepare recipes; each one still needs your approval and your run command' : 'verification execution disabled')
      return 0
    }
    if (cmd === 'approve' && id) {
      const before = catalog.verification(id)
      if (!before) throw new ProofmeshError('NOT_FOUND', `no verification ${id}`)
      const v = catalog.approveVerification(id, before.binding_hash, approver())
      console.log(`approved ${v.id} by ${v.approved_by} until ${v.expires_at}; it runs once with: proofmesh verification run ${v.id}`)
      console.log(JSON.stringify(v.binding, null, 2))
      return 0
    }
    throw new ProofmeshError('INVALID_ARGUMENT', USAGE)
  } finally {
    catalog.close()
  }
}
