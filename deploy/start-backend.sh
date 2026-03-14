#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-7878}"
NODE_ENV="${NODE_ENV:-production}"

cd "${ROOT_DIR}"

if [ ! -d node_modules ]; then
  npm ci
fi

if [ ! -f dist/server/index.js ]; then
  npm run build
fi

echo "Starting Wikipedia backend on ${HOST}:${PORT}"
echo "Working directory: ${ROOT_DIR}"

exec env HOST="${HOST}" PORT="${PORT}" NODE_ENV="${NODE_ENV}" npm run start
