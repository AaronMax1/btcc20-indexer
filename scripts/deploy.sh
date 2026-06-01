#!/usr/bin/env sh
set -eu

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Review RPC password and ports before public deployment."
fi

env_value() {
  grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true
}

BTCCD_IMAGE="${BTCCD_IMAGE:-$(env_value BTCCD_IMAGE)}"
BTCCD_IMAGE="${BTCCD_IMAGE:-btcc-core:local}"

docker compose build btcc20-indexer

if [ "${FORCE_BTCCD_BUILD:-0}" = "1" ] || ! docker image inspect "$BTCCD_IMAGE" >/dev/null 2>&1; then
  docker compose build --no-cache btccd
else
  echo "Using existing BTCC Core image: $BTCCD_IMAGE"
fi

docker compose up -d --no-build
docker compose ps
