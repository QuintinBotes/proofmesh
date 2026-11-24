#!/bin/sh
# Rebuild cost of both tools: a no-change rebuild, a one-function edit, and the revert.
# Usage: sh incremental.sh <orbit-copy>     (never point it at a real checkout: it edits src/core/hash.ts and restores it)
# Writes out/incremental.txt. Both builds are code-only, no model call.
set -eu
REPO="${1:?usage: incremental.sh <repo-copy>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PM="$HERE/pm"
OUT="$HERE/out/incremental.txt"
mkdir -p "$HERE/out"
unset ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY OPENAI_API_KEY 2>/dev/null || true
now() { node -e 'process.stdout.write(String(Date.now()))'; }
DATA="${PM_DATA_DIR:-$HERE/../../.bench-data}"
timed() { # label, command...
  label="$1"; shift
  t0=$(now); "$@" > "$HERE/out/incr-$label.log" 2>&1; t1=$(now)
  case "$label" in graphify-*) disk="graphify-out $(du -sh graphify-out | cut -f1)" ;; *) disk="data dir $(du -sh "$DATA" | cut -f1)" ;; esac
  echo "$label $((t1 - t0)) ms, $disk" | tee -a "$OUT"
}
: > "$OUT"
cd "$REPO"
timed graphify-nochange graphify update "$REPO"
timed proofmesh-nochange "$PM" index "$REPO"
# A unique comment per run, so neither tool can reuse a cached result for content it saw in an earlier run.
RUN_TAG="$(now)"
cat >> src/core/hash.ts <<EOF

// bench run $RUN_TAG
export function benchProbe(value: unknown): string {
  return canonicalJson(value);
}
EOF
timed graphify-edit graphify update "$REPO"
timed proofmesh-edit "$PM" index "$REPO"
# Did each tool pick up the new call benchProbe -> canonicalJson?
if grep -q '"src_core_hash_benchprobe"' graphify-out/graph.json; then echo "graphify sees benchProbe: yes" | tee -a "$OUT"; else echo "graphify sees benchProbe: no" | tee -a "$OUT"; fi
graphify explain src_core_hash_benchprobe 2>&1 | grep -i "canonicalJson" | head -1 | sed 's/^/graphify edge: /' | tee -a "$OUT" || true
grep -E "plan|reused|analy" "$HERE/out/incr-proofmesh-edit.log" | head -3 | sed 's/^/proofmesh: /' | tee -a "$OUT" || true
git checkout -- src/core/hash.ts
timed graphify-revert graphify update "$REPO"
timed proofmesh-revert "$PM" index "$REPO"
grep -q '"src_core_hash_benchprobe"' graphify-out/graph.json && echo "graphify still has benchProbe after revert: yes" | tee -a "$OUT" || echo "graphify still has benchProbe after revert: no" | tee -a "$OUT"

# A leaf edit: a file few others import (src/cli/commands/repair.ts), the common case for an agent's change.
printf '\n// bench run %s\nexport function benchLeafProbe(): number {\n  return 1;\n}\n' "$RUN_TAG" >> src/cli/commands/repair.ts
timed graphify-leaf-edit graphify update "$REPO"
timed proofmesh-leaf-edit "$PM" index "$REPO"
grep -E "reused" "$HERE/out/incr-proofmesh-leaf-edit.log" | head -1 | sed 's/^/proofmesh leaf: /' | tee -a "$OUT" || true
git checkout -- src/cli/commands/repair.ts
timed graphify-leaf-revert graphify update "$REPO"
timed proofmesh-leaf-revert "$PM" index "$REPO"
