#!/bin/sh
# The pinned public fixture of the parity (#25) and Observatory (#41) benchmarks: TypeORM's src/ and LICENSE at one commit.
# Prints the fixture's directory: PARITY_FIXTURE, default $TMPDIR/parity-typeorm, built there on first use (network).
set -eu
FIXTURE="${PARITY_FIXTURE:-${TMPDIR:-/tmp}/parity-typeorm}"
COMMIT=3d55188c0dd1256f520143379ecf97f45e71acba # TypeORM, MIT; questions.json names symbols at this commit

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
  printf 'Source: https://github.com/typeorm/typeorm\nCommit: %s\nLicence: MIT (LICENSE)\nCopied: src/ and LICENSE only, for the ProofMesh benchmarks (bench/parity, bench/observatory); never committed there.\n' "$COMMIT" > "$FIXTURE/PROVENANCE"
  git init -q "$FIXTURE"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" -c user.name=parity -c user.email=parity@localhost commit -q -m "typeorm $COMMIT src/"
  # A rename onto a directory another run has just put there fails; that run's fixture is the same and is kept.
  node -e 'try { require("fs").renameSync(process.argv[1], process.argv[2]) } catch (e) { if (e.code !== "ENOTEMPTY" && e.code !== "EEXIST") throw e }' "$FIXTURE" "$FIXTURE_FINAL"
  FIXTURE="$FIXTURE_FINAL"
  rm -rf "$BUILD"
fi
echo "$FIXTURE"
