#!/usr/bin/env sh
set -eu

env_value() {
  grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true
}

BTCC20_VIEWER_PORT="${BTCC20_VIEWER_PORT:-$(env_value BTCC20_VIEWER_PORT)}"
BTCC20_VIEWER_PORT="${BTCC20_VIEWER_PORT:-8798}"
BTCCD_RPC_PORT="${BTCCD_RPC_PORT:-$(env_value BTCCD_RPC_PORT)}"
BTCCD_RPC_PORT="${BTCCD_RPC_PORT:-28476}"
BTCC20_RPC_USER="${BTCC20_RPC_USER:-$(env_value BTCC20_RPC_USER)}"
BTCC20_RPC_USER="${BTCC20_RPC_USER:-btcc_rpc_user}"
BTCC20_RPC_PASSWORD="${BTCC20_RPC_PASSWORD:-$(env_value BTCC20_RPC_PASSWORD)}"
BTCC20_RPC_PASSWORD="${BTCC20_RPC_PASSWORD:-change_me}"

echo "== Containers =="
docker compose ps

echo
echo "== BTCC node =="
docker compose exec -T btccd bitcoin-cli \
  -rpcconnect=127.0.0.1 \
  -rpcport="$BTCCD_RPC_PORT" \
  -rpcuser="$BTCC20_RPC_USER" \
  -rpcpassword="$BTCC20_RPC_PASSWORD" \
  getblockchaininfo

echo
echo "== Indexer =="
curl -sS "http://127.0.0.1:${BTCC20_VIEWER_PORT}/api/index/status"
echo
