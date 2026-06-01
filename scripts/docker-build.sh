#!/usr/bin/env sh
set -eu

IMAGE="${IMAGE:-btcc20-indexer:latest}"

docker build -t "$IMAGE" .

