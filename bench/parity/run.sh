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
FIXTURE="${PARITY_FIXTURE:-${TMPDIR:-/tmp}/parity-typeorm}"
COMMIT=3d55188c0dd1256f520143379ecf97f45e71acba # TypeORM, MIT; questions.json names symbols at this commit
PATH="$TOOLS/bin:$TOOLS/npm/node_modules/.bin:$PATH"
# Runs are offline and no tool may call a model.
unset ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY OPENAI_API_KEY DEEPSEEK_API_KEY KIMI_API_KEY OPENROUTER_API_KEY 2>/dev/null || true
export PATH SERENA_HOME="$TOOLS/serena-home" SERENA_USAGE_REPORTING=false

# The fixture: src/ and LICENSE alone, in a new repository, with the tsconfig below and no node_modules. It is built in a
# directory of its own and moved into place by one rename, so runs that start together share one whole fixture, which
# no run writes to: each works on its own copy (run.mjs).
if [ -e "$FIXTURE" ] && [ ! -f "$FIXTURE/PROVENANCE" ]; then
  echo "parity: $FIXTURE is not a parity fixture (no PROVENANCE); remove it or set PARITY_FIXTURE to another directory" >&2
  exit 1
fi
if [ ! -e "$FIXTURE" ]; then
  mkdir -p "$(dirname "$FIXTURE")"
  BUILD="$(mktemp -d "$FIXTURE.build.XXXXXX")"
  trap 'rm -rf "$BUILD"' EXIT
  CLONE="$BUILD/clone" FIXTURE_FINAL="$FIXTURE" FIXTURE="$BUILD/fixture"
  git init -q "$CLONE"
  git -C "$CLONE" fetch -q --depth 1 https://github.com/typeorm/typeorm.git "$COMMIT"
  git -C "$CLONE" checkout -q FETCH_HEAD
  mkdir -p "$FIXTURE"
  cp -R "$CLONE/src" "$CLONE/LICENSE" "$FIXTURE/"
  cat > "$FIXTURE/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "es2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["es2020"],
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": false,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
EOF
  printf 'Source: https://github.com/typeorm/typeorm\nCommit: %s\nLicence: MIT (LICENSE)\nCopied: src/ and LICENSE only, for bench/parity of ProofMesh; never committed there.\n' "$COMMIT" > "$FIXTURE/PROVENANCE"
  git init -q "$FIXTURE"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" -c user.name=parity -c user.email=parity@localhost commit -q -m "typeorm $COMMIT src/"
  # A rename onto a directory another run has just put there fails; that run's fixture is the same and is kept.
  node -e 'try { require("fs").renameSync(process.argv[1], process.argv[2]) } catch (e) { if (e.code !== "ENOTEMPTY" && e.code !== "EEXIST") throw e }' "$FIXTURE" "$FIXTURE_FINAL"
  FIXTURE="$FIXTURE_FINAL"
  rm -rf "$BUILD"
fi
node "$HERE/run.mjs" --fixture "$FIXTURE"
