#!/bin/sh
# Large tier: ProofMesh alone on a pinned, permissively licensed public polyglot repository of at least 20,000 source files.
#
#   sh bench/graph-bench/run-large.sh [<aspnetcore-clone-or-url> [<copy-dir>]]
#
# It reports, as the median of 3 runs each (NFR005), with the machine described: cold index time, peak memory per adapter process,
# store size, the time and files re-analysed for a one-file edit, and seconds per file per adapter. No budget is promised before
# these are measured (FR-TBD-5 of issue 6); the owner sets budgets from the first results, in docs/proofmesh/operations.md.
#
# Needs a machine with 16 GB or more, the .NET SDK for the C# adapter, and time and disk for a clone of the repository: run it on its
# own, never next to other builds. It takes the shared benchmark lock of the agent workflow if you wrap it as run-all.sh is wrapped.
# Results: out/large.md and out/large.json. Each figure is the median of the three runs' figures; a cold run starts on an empty data
# directory, and the edit run changes one C# file by one comment line and restores it.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-https://github.com/dotnet/aspnetcore.git}"
COPY="${2:-${TMPDIR:-/tmp}/graph-bench-large}"
COMMIT=7387de91234d3ef751fa50b3d1bfede4130213ff # tag v10.0.0 of dotnet/aspnetcore (MIT)
EDIT=src/Http/Http/src/HeaderDictionary.cs
OUT="$HERE/out/large"; mkdir -p "$OUT"
ROOT="$(cd "$HERE/../.." && pwd)"
unset ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY OPENAI_API_KEY 2>/dev/null || true
now() { node -e 'process.stdout.write(String(Date.now()))'; }

if [ ! -d "$COPY/.git" ]; then git clone --filter=blob:none "$SRC" "$COPY"; fi
git -C "$COPY" checkout -q --detach "$COMMIT"
[ -f "$COPY/$EDIT" ] || { echo "edit target $EDIT is not in $COMMIT" >&2; exit 1; }

# The tier is only meaningful on at least 20,000 source files in at least 3 languages.
files=$(git -C "$COPY" ls-files | wc -l | tr -d ' ')
langs=$(git -C "$COPY" ls-files | sed -n 's/.*\.\(cs\|ts\|tsx\|js\|cpp\|h\|ps1\|py\|go\|java\)$/\1/p' | sort -u | wc -l | tr -d ' ')
[ "$files" -ge 20000 ] && [ "$langs" -ge 3 ] || { echo "need >= 20000 files in >= 3 languages, found $files files, $langs source extensions" >&2; exit 1; }

for n in 1 2 3; do
  DATA="$OUT/data-$n"; rm -rf "$DATA"
  P="node $ROOT/packages/proofmesh/bin/proofmesh.mjs --data-dir $DATA"
  $P init >/dev/null; $P repo add "$COPY" >/dev/null
  t0=$(now); $P index "$COPY" > "$OUT/cold-$n.log" 2> "$OUT/cold-$n.err"; t1=$(now)
  echo "$((t1 - t0))" > "$OUT/cold-$n.ms"
  du -sk "$DATA" | cut -f1 > "$OUT/store-$n.kb"
  printf '\n// bench run %s\n' "$(now)" >> "$COPY/$EDIT"
  t0=$(now); $P index "$COPY" > "$OUT/edit-$n.log" 2> "$OUT/edit-$n.err"; t1=$(now)
  echo "$((t1 - t0))" > "$OUT/edit-$n.ms"
  git -C "$COPY" checkout -q -- "$EDIT"
  rm -rf "$DATA"
done

node - "$OUT" "$COMMIT" "$files" <<'JS'
const fs = require('fs'), os = require('os'), [out, commit, files] = process.argv.slice(2)
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const read = (f) => fs.readFileSync(`${out}/${f}`, 'utf8')
const runs = [1, 2, 3].map((n) => {
  const cold = read(`cold-${n}.log`), edit = read(`edit-${n}.log`)
  const per = (re) => Object.fromEntries([...cold.matchAll(re)].map((m) => [m[1], Number(m[2])]))
  const peak = {}; for (const m of (/^adapter peak memory (.*)$/m.exec(cold)?.[1] ?? '').matchAll(/(\w+) ([\d.]+) (MiB|GiB)/g)) peak[m[1]] = Number(m[2]) * (m[3] === 'GiB' ? 1024 : 1)
  const perFile = Object.fromEntries(((/^adapter seconds per file (.*)$/m.exec(cold)?.[1]) ?? '').split(', ').filter(Boolean).map((x) => x.split(' ')).map(([id, s]) => [id, Number(s)]))
  const reused = /reused the facts of (\d+) of (\d+) files/.exec(edit)
  return { cold_ms: Number(read(`cold-${n}.ms`)), peak_mb: peak, store_mb: Number(read(`store-${n}.kb`)) / 1024, edit_ms: Number(read(`edit-${n}.ms`)), edit_reanalysed: reused ? Number(reused[2]) - Number(reused[1]) : null, seconds_per_file: perFile }
})
const keys = (f) => [...new Set(runs.flatMap((r) => Object.keys(f(r))))]
const med = (f) => Object.fromEntries(keys(f).map((k) => [k, median(runs.map((r) => f(r)[k]).filter((v) => v !== undefined))]))
const report = {
  commit, files: Number(files), runs: runs.length, machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, memory_gb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}` },
  median: { cold_index_ms: median(runs.map((r) => r.cold_ms)), peak_memory_mb_per_adapter: med((r) => r.peak_mb), store_size_mb: median(runs.map((r) => r.store_mb)), edit_index_ms: median(runs.map((r) => r.edit_ms)), edit_files_reanalysed: median(runs.map((r) => r.edit_reanalysed ?? NaN)), seconds_per_file: med((r) => r.seconds_per_file) },
  raw: runs,
}
fs.writeFileSync(`${out}/../large.json`, JSON.stringify(report, null, 2) + '\n')
const m = report.median
fs.writeFileSync(`${out}/../large.md`, [
  `Large tier, median of 3 runs, dotnet/aspnetcore ${commit.slice(0, 12)} (${files} files); ${report.machine.cpu}, ${report.machine.cores} cores, ${report.machine.memory_gb} GB, ${report.machine.platform}`,
  `- cold index: ${(m.cold_index_ms / 1000).toFixed(1)} s`,
  `- peak memory per adapter process (MB): ${JSON.stringify(m.peak_memory_mb_per_adapter)}`,
  `- store size: ${m.store_size_mb.toFixed(0)} MB`,
  `- one-file edit: ${(m.edit_index_ms / 1000).toFixed(1)} s, ${m.edit_files_reanalysed} files re-analysed`,
  `- seconds per file per adapter: ${JSON.stringify(m.seconds_per_file)}`, '',
].join('\n'))
console.log(fs.readFileSync(`${out}/../large.md`, 'utf8'))
JS
