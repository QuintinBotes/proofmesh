// Shared by fresh.mjs (a Node script) and register.mjs (the hooks module), so both pick the same repository. No Node APIs here.

/** The registered repository whose root holds `real` (a resolved absolute path), the deepest when roots nest, from `proofmesh repo list`'s output; null when none does. */
export function deepestRoot(listed, real, sep) {
  return listed.split('\n').map((l) => l.split('  ')).filter((c) => c.length >= 3).map(([id, name, root]) => ({ id, name, root }))
    .filter((x) => real === x.root || real.startsWith(x.root + sep)).sort((a, b) => b.root.length - a.root.length)[0] ?? null
}
