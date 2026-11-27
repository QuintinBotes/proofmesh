#!/bin/sh
# Cross-repository calls on a public library and application pair (#28, scenario 4): Excalibur and its sample game sample-tactics.
#
#   sh bench/parity/xrepo.sh          prints the score and exits 1 under 95%
#
# Needs ProofMesh built in this clone, Node, git and npm. The fixture is fetched once (network) into PARITY_XREPO (default
# $TMPDIR/parity-xrepo); every run after that is offline and works on its own copy of it (xrepo.mjs). None of its code is
# ever committed here.
set -eu
MODE="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="${PARITY_XREPO:-${TMPDIR:-/tmp}/parity-xrepo}"
PACKAGE=excalibur VERSION=0.32.0
LIB_URL=https://github.com/excaliburjs/Excalibur.git LIB_COMMIT=7cb426da0dae70eb50a42341a35e7bbd74395579 # tag v0.32.0, BSD-2-Clause
APP_URL=https://github.com/excaliburjs/sample-tactics.git APP_COMMIT=bfe18ba107897ab5c662fdb909fb0b10669daf1a # BSD-2-Clause; excalibur ^0.32.0

if [ -e "$FIXTURE" ] && [ ! -f "$FIXTURE/PROVENANCE" ]; then
  echo "xrepo: $FIXTURE is not a parity fixture (no PROVENANCE); remove it or set PARITY_XREPO to another directory" >&2
  exit 1
fi
if [ ! -e "$FIXTURE" ]; then
  mkdir -p "$(dirname "$FIXTURE")"
  BUILD="$(mktemp -d "$FIXTURE.build.XXXXXX")"
  trap 'rm -rf "$BUILD"' EXIT
  for side in lib app; do
    if [ "$side" = lib ]; then url=$LIB_URL commit=$LIB_COMMIT; else url=$APP_URL commit=$APP_COMMIT; fi
    git init -q "$BUILD/clone-$side"
    git -C "$BUILD/clone-$side" fetch -q --depth 1 "$url" "$commit"
    git -C "$BUILD/clone-$side" checkout -q FETCH_HEAD
    # Only the sources, the licence and the manifests: no tests, sandbox, site or assets.
    mkdir -p "$BUILD/fixture/$side"
    (cd "$BUILD/clone-$side" && cp -R src LICENSE* package.json tsconfig.json "$BUILD/fixture/$side/")
  done
  rm -rf "$BUILD/fixture/lib/src/spec" "$BUILD/fixture/lib/src/stories"
  # What `npm install` leaves in the application: the published package, at the version the library's commit builds.
  (cd "$BUILD" && npm pack --silent "$PACKAGE@$VERSION" > /dev/null)
  mkdir -p "$BUILD/fixture/installed/$PACKAGE"
  tar -xzf "$BUILD/$PACKAGE-$VERSION.tgz" -C "$BUILD/fixture/installed/$PACKAGE" --strip-components 1
  printf '{ "package": "%s", "entry": "lib/src/engine/index.ts" }\n' "$PACKAGE" > "$BUILD/fixture/pair.json"
  printf 'Library: %s at %s (%s %s), src/ licence package.json tsconfig.json in lib/, without src/spec and src/stories\nApplication: %s at %s, the same files in app/\nInstalled: the npm package %s@%s in installed/%s\nFor bench/parity of ProofMesh; never committed there.\n' \
    "$LIB_URL" "$LIB_COMMIT" "$PACKAGE" "$VERSION" "$APP_URL" "$APP_COMMIT" "$PACKAGE" "$VERSION" "$PACKAGE" > "$BUILD/fixture/PROVENANCE"
  node -e 'try { require("fs").renameSync(process.argv[1], process.argv[2]) } catch (e) { if (e.code !== "ENOTEMPTY" && e.code !== "EEXIST") throw e }' "$BUILD/fixture" "$FIXTURE"
  rm -rf "$BUILD"
fi
[ "$MODE" = "--fixture-only" ] && exit 0
node "$HERE/xrepo.mjs" --fixture "$FIXTURE"
