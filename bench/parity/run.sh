#!/bin/sh
# Parity benchmark (#25): ProofMesh and every local alternative, scored on one truth over one pinned public fixture.
#
#   sh bench/parity/run.sh            then read bench/parity/out/parity.md
#
# Needs ProofMesh built in this clone (pnpm install --frozen-lockfile && pnpm build), Node, git, sqlite3 and
# /usr/bin/time. Comparators are found on PATH, after $PARITY_TOOLS/bin and $PARITY_TOOLS/npm/node_modules/.bin
# (install.sh puts the pinned versions there); a comparator missing or at another version is reported `not run`.
# PARITY_FIXTURE moves the fixture (default $TMPDIR/parity-typeorm; each run works on its own copy of it), PARITY_OUT
# the results (default out/), and PARITY_RUNS sets the runs per median (3).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="${PARITY_TOOLS:-$HOME/.local/share/proofmesh-parity}"
PATH="$TOOLS/bin:$TOOLS/npm/node_modules/.bin:$PATH"
# Runs are offline and no tool may call a model.
unset ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY OPENAI_API_KEY DEEPSEEK_API_KEY KIMI_API_KEY OPENROUTER_API_KEY 2>/dev/null || true
export PATH SERENA_HOME="$TOOLS/serena-home" SERENA_USAGE_REPORTING=false

FIXTURE="$(sh "$HERE/fixture.sh")"
node "$HERE/run.mjs" --fixture "$FIXTURE"
