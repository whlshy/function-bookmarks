#!/usr/bin/env bash
# setup() { not this }
set -e

log() {
  echo "[$(date)] $*"   # a } in a comment
}

function deploy {
  local target=${1:-prod}
  echo "len ${#target}"
  cat <<EOF
fake() {
EOF
  if [ "$target" = "prod" ]; then
    log "deploying '$target'"
  fi
}

function cleanup() {
  echo 'done }'
}

cleanup
