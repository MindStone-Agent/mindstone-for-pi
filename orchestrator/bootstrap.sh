#!/usr/bin/env bash
# MindStone for Pi bootstrap helper.
# Installs this directory as a Pi package, then reminds the user to run /ms-init.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "MindStone for Pi — bootstrap"
echo "============================"
echo "Package root: $REPO_ROOT"
echo ""

if ! command -v pi >/dev/null 2>&1; then
  echo "ERROR: pi is not on PATH. Install Pi first."
  exit 1
fi

echo "Installing local Pi package..."
pi install "$REPO_ROOT"

echo ""
echo "Bootstrap complete."
echo ""
echo "Next steps:"
echo "  1. Start or reload Pi."
echo "  2. Run /ms-init"
echo "  3. Run /ms-onboard for fresh identity onboarding."
echo "  4. Edit ~/.pi/agent/mindstone/orchestrator/IDENTITY.md and USER.md as guided."
