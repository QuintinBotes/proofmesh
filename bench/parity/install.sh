#!/bin/sh
# Installs the pinned comparators of bench/parity in user space, under $PARITY_TOOLS (default
# ~/.local/share/proofmesh-parity), and never as a dependency of any package here. Needs uv, npm and gh (or curl).
#   Graphify 0.9.108, Serena 2.1.0, aider-chat 0.86.2: uv tool install, with their own tool and bin directories,
#     so a graphify, serena or aider already on PATH is left as it is;
#   scip-typescript 0.3.15: npm, under $PARITY_TOOLS/npm;
#   ast-grep 0.51.1 (MIT), for bench/structure: npm, under $PARITY_TOOLS/npm;
#   the scip CLI 0.10.0: the release binary, checked against its published sha256, into $PARITY_TOOLS/bin.
# Network is needed here only; run.sh runs offline.
set -eu
TOOLS="${PARITY_TOOLS:-$HOME/.local/share/proofmesh-parity}"
mkdir -p "$TOOLS/bin"
export UV_TOOL_DIR="$TOOLS/uv" UV_TOOL_BIN_DIR="$TOOLS/bin"
uv tool install graphifyy==0.9.108
uv tool install --python 3.11 serena-agent==2.1.0
uv tool install --python 3.11 aider-chat==0.86.2
npm install --prefix "$TOOLS/npm" --no-audit --no-fund @sourcegraph/scip-typescript@0.3.15 @ast-grep/cli@0.51.1
# Serena fetches its TypeScript language server once, into its own home, not ~/.serena.
SERENA_HOME="$TOOLS/serena-home" SERENA_USAGE_REPORTING=false "$TOOLS/bin/serena" download-ls-dependencies typescript

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET=scip-darwin-arm64 ;; Darwin-x86_64) ASSET=scip-darwin-amd64 ;;
  Linux-aarch64 | Linux-arm64) ASSET=scip-linux-arm64 ;; *) ASSET=scip-linux-amd64 ;;
esac
TMP="$(mktemp -d)"
URL="https://github.com/sourcegraph/scip/releases/download/v0.10.0/$ASSET.tar.gz"
curl -fsSL -o "$TMP/$ASSET.tar.gz" "$URL"
curl -fsSL -o "$TMP/$ASSET.tar.gz.sha256" "$URL.sha256"
(cd "$TMP" && shasum -a 256 -c "$ASSET.tar.gz.sha256")
tar -xzf "$TMP/$ASSET.tar.gz" -C "$TMP" scip
install -m 755 "$TMP/scip" "$TOOLS/bin/scip"
rm -rf "$TMP"
echo "installed under $TOOLS; run.sh puts $TOOLS/bin and $TOOLS/npm/node_modules/.bin first on its PATH"
