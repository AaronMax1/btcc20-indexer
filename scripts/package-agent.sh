#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DIST="$ROOT/public/downloads"
WORK="$ROOT/.agent-dist/btcc20-agent"

rm -rf "$ROOT/.agent-dist"
mkdir -p "$WORK" "$DIST"

cp "$ROOT/agent.mjs" "$WORK/agent.mjs"
cp "$ROOT/agent-package/README.md" "$WORK/README.md"
cp "$ROOT/agent-package/start-agent.sh" "$WORK/start-agent.sh"
cp "$ROOT/agent-package/start-agent.bat" "$WORK/start-agent.bat"
chmod +x "$WORK/start-agent.sh"

(cd "$ROOT/.agent-dist" && zip -qr "$DIST/btcc20-agent-local.zip" btcc20-agent)

echo "$DIST/btcc20-agent-local.zip"
