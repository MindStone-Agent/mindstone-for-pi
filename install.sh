#!/usr/bin/env bash
# install.sh — Install MindStone for Pi (MS4PI) into this Pi environment.
#
# Public installer. It clones/updates the MS4PI framework checkout under
# ~/.pi/agent/mindstone-for-pi, installs it as a Pi package, and prepares the
# Python recall/indexing venv. It never overwrites private identity/user/log/
# memory data under ~/.pi/agent/mindstone.
#
# Usage:
#   ./install.sh [--ref GITREF] [--dir DIR] [--source DIR] [--no-bootstrap]
#
# Curl:
#   curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/mindstone-for-pi/main/install.sh | bash

set -euo pipefail

REPO_URL="https://github.com/MindStone-Agent/mindstone-for-pi.git"
REF="main"
INSTALL_DIR="$HOME/.pi/agent/mindstone-for-pi"
SOURCE_DIR=""
RUN_BOOTSTRAP=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2;;
    --dir) INSTALL_DIR="$2"; shift 2;;
    --source) SOURCE_DIR="$2"; shift 2;;
    --no-bootstrap) RUN_BOOTSTRAP=0; shift;;
    -h|--help) sed -n '2,17p' "$0"; exit 0;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2;;
  esac
done

log() { printf '  %s\n' "$*"; }
section() { printf '\n[%s] %s\n' "$1" "$2"; }

for tool in git pi; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' is required but not found." >&2; exit 1; }
done

mkdir -p "$(dirname "$INSTALL_DIR")"

echo "MindStone for Pi — installer"
echo "============================"
echo "Install dir: $INSTALL_DIR"
echo "Requested ref: $REF"

if [[ -n "$SOURCE_DIR" ]]; then
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
  section 1 "Using local source $SOURCE_DIR"
  if [[ ! -d "$INSTALL_DIR/.git" ]]; then
    git clone --quiet "$SOURCE_DIR" "$INSTALL_DIR"
  else
    log "checkout already exists"
  fi
  (cd "$INSTALL_DIR" && git fetch --quiet "$SOURCE_DIR" && git checkout --quiet "$(cd "$SOURCE_DIR" && git rev-parse HEAD)")
else
  section 1 "Fetching MS4PI from $REPO_URL"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "existing checkout found; fetching"
    (cd "$INSTALL_DIR" && git fetch --quiet origin)
  elif [[ -e "$INSTALL_DIR" ]]; then
    echo "ERROR: install dir exists but is not a git checkout: $INSTALL_DIR" >&2
    exit 1
  else
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  fi
  (cd "$INSTALL_DIR" && git checkout --quiet "$REF" && git pull --ff-only --quiet || true)
fi

RESOLVED_REF="$(cd "$INSTALL_DIR" && git rev-parse HEAD)"
log "resolved ref: $RESOLVED_REF"

section 2 "Bootstrap"
if [[ "$RUN_BOOTSTRAP" -eq 1 ]]; then
  bash "$INSTALL_DIR/orchestrator/bootstrap.sh"
else
  log "skipped (--no-bootstrap). Run later: bash $INSTALL_DIR/orchestrator/bootstrap.sh"
fi

cat > "$INSTALL_DIR/.ms4pi-version" <<EOF
ref=$RESOLVED_REF
requested=$REF
installed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
repo=$REPO_URL
EOF

cat <<EOF

=====================================
MS4PI install complete.

Next:
  1. Start or reload Pi.
  2. Run /ms-init
  3. Run /ms-onboard
  4. Run /ms-recall-status
  5. Run /ms-recall-backfill

EOF
