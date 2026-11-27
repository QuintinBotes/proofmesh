#!/bin/sh
# Graphify vs ProofMesh on a COPY of the Orbit repository, pinned to the commit the questions were written for.
# Offline and deterministic: Graphify runs code-only (`graphify update`, no model call), ProofMesh runs no model.
#
#   sh bench/graph-bench/run-all.sh [<orbit-clone-or-url> [<copy-dir>]]
#
# Prerequisites: ProofMesh built in this clone (pnpm install --frozen-lockfile && pnpm build), graphify on PATH
# (uv tool install graphifyy), sqlite3 and git. Results: out/results.md (table), out/results.json (per-question
# misses and extras), out/raw/ (every tool answer), out/build.txt and out/incremental.txt (build and rebuild costs).
# Files: truth.mjs (TypeScript-checker ground truth), questions.json (the 13 questions), run.mjs (asks both tools and
# scores them), incremental.sh (no-change, edit and revert rebuilds), mcp-client.mjs, pm (ProofMesh CLI with the
# benchmark's own data directory, .bench-data/ at the root of this clone; never the default one).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-https://github.com/QuintinBotes/orbit.git}"
COPY="${2:-${TMPDIR:-/tmp}/graph-bench-orbit}"
COMMIT=5bd5dffa06c4c7360ba8d6023d0d438207929211 # questions.json names symbols at this commit
OUT="$HERE/out"; mkdir -p "$OUT"
unset ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY OPENAI_API_KEY 2>/dev/null || true
now() { node -e 'process.stdout.write(String(Date.now()))'; }
# Peak RSS of the largest process in the tree, from /usr/bin/time (BSD -l prints bytes, GNU -v prints kbytes).
case "$(uname)" in Darwin) TIMEV=-l ;; *) TIMEV=-v ;; esac
rss() { awk '/maximum resident set size/ { printf "%d MB", $1 / 1048576 } /Maximum resident set size/ { printf "%d MB", $NF / 1024 }' "$1"; }

if [ ! -d "$COPY/.git" ]; then git clone "$SRC" "$COPY"; fi
git -C "$COPY" checkout -q --detach "$COMMIT"
grep -qx "graphify-out/" "$COPY/.git/info/exclude" || echo "graphify-out/" >> "$COPY/.git/info/exclude"
[ -d "$COPY/node_modules" ] || (cd "$COPY" && npm ci --ignore-scripts --no-audit --no-fund) # type declarations for the checker and ProofMesh

: > "$OUT/build.txt"
rm -rf "$COPY/graphify-out" # a full build: graphify update reuses an existing graph
t0=$(now); (cd "$COPY" && /usr/bin/time $TIMEV graphify update "$COPY") > "$OUT/build-graphify.log" 2>&1; t1=$(now)
echo "graphify full build $((t1 - t0)) ms, peak RSS $(rss "$OUT/build-graphify.log"), $(du -sh "$COPY/graphify-out" | cut -f1) on disk" | tee -a "$OUT/build.txt"
"$HERE/pm" init >/dev/null 2>&1 || true
"$HERE/pm" repo add "$COPY" >/dev/null 2>&1 || true
t0=$(now); /usr/bin/time $TIMEV "$HERE/pm" index "$COPY" > "$OUT/build-proofmesh.log" 2>&1; t1=$(now)
echo "proofmesh full build $((t1 - t0)) ms (cold only on a new data directory), peak RSS $(rss "$OUT/build-proofmesh.log"), $(du -sh "${PM_DATA_DIR:-$HERE/../../.bench-data}" | cut -f1) on disk" | tee -a "$OUT/build.txt"

node "$HERE/truth.mjs" "$COPY" "$OUT/truth.json"
node "$HERE/run.mjs" --repo "$COPY"
sh "$HERE/incremental.sh" "$COPY"
