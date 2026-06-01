#!/usr/bin/env sh
set -eu

INDEXER_IMAGE="${INDEXER_IMAGE:-btcc20-indexer:latest}"
BTCCD_IMAGE="${BTCCD_IMAGE:-btcc-core:local}"

docker build -t "$INDEXER_IMAGE" .

# Rebuild the node image without cache so BTCCD_REF=main pulls the latest
# Bitcoin-Classic source instead of reusing an older git-clone layer.
docker compose build --no-cache btccd
