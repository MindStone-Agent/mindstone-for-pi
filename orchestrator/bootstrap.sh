#!/usr/bin/env bash
# MindStone for Pi bootstrap helper.
# Installs this directory as a Pi package and prepares the MS4CC-style
# Python recall/indexing stack used by MS4PI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORCHESTRATOR_DIR="$REPO_ROOT/orchestrator"
VENV_DIR="$ORCHESTRATOR_DIR/.venv"
DATA_ROOT="${MINDSTONE_PI_ROOT:-$HOME/.pi/agent/mindstone}"
DATA_ORCHESTRATOR_DIR="$DATA_ROOT/orchestrator"


echo "MindStone for Pi — bootstrap"
echo "============================"
echo "Package root:       $REPO_ROOT"
echo "Package orchestrator: $ORCHESTRATOR_DIR"
echo "Data root:          $DATA_ROOT"
echo ""

if ! command -v pi >/dev/null 2>&1; then
  echo "ERROR: pi is not on PATH. Install Pi first."
  exit 1
fi

mkdir -p "$DATA_ORCHESTRATOR_DIR/memory" "$DATA_ORCHESTRATOR_DIR/transcripts" "$DATA_ORCHESTRATOR_DIR/roles" "$DATA_ORCHESTRATOR_DIR/templates"

# ---------------------------------------------------------------------------
# Python recall/indexing venv
# ---------------------------------------------------------------------------

echo "[1/3] Python recall/indexing environment..."
if command -v uv >/dev/null 2>&1; then
  echo "  Using uv"
  (cd "$ORCHESTRATOR_DIR" && uv sync --quiet) || {
    echo "  WARN: uv sync failed; falling back to venv + pip"
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip
    "$VENV_DIR/bin/pip" install --quiet -e "$ORCHESTRATOR_DIR"
  }
else
  echo "  uv not found; using stdlib venv + pip"
  if [[ ! -d "$VENV_DIR" ]]; then
    python3 -m venv "$VENV_DIR"
  fi
  "$VENV_DIR/bin/pip" install --quiet --upgrade pip
  "$VENV_DIR/bin/pip" install --quiet -e "$ORCHESTRATOR_DIR"
fi

"$VENV_DIR/bin/python" -c "import openai, sqlite_vec" || {
  echo "  ERROR: recall dependencies failed to import."
  exit 1
}
echo "  OK: openai + sqlite-vec installed"
echo ""

# ---------------------------------------------------------------------------
# Install package
# ---------------------------------------------------------------------------

echo "[2/3] Installing local Pi package..."
pi install "$REPO_ROOT"
echo ""

# ---------------------------------------------------------------------------
# Recall status
# ---------------------------------------------------------------------------

echo "[3/3] Recall status..."
MS4PI_ORCHESTRATOR_DIR="$DATA_ORCHESTRATOR_DIR" "$VENV_DIR/bin/python" "$ORCHESTRATOR_DIR/hooks/recall_status.py" || true

echo ""
echo "Bootstrap complete."
echo ""
echo "Next steps:"
echo "  1. Start or reload Pi."
echo "  2. Run /ms-init"
echo "  3. Run /ms-onboard for fresh identity/user onboarding."
echo "  4. Run /ms-recall-status"
echo "  5. Run /ms-recall-backfill once embedding provider is configured."
