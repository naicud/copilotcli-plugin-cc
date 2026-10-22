#!/usr/bin/env bash
# One-line installer for copilotcli-plugin-cc (Claude Code plugin).
#
#   ! curl -fsSL https://raw.githubusercontent.com/naicud/copilotcli-plugin-cc/main/install.sh | bash
#
# Equivalent to `/plugin marketplace add naicud/copilotcli-plugin-cc` followed by
# `/plugin install copilot@naicud-copilotcli-plugin-cc` inside Claude Code.

set -euo pipefail

REPO="naicud/copilotcli-plugin-cc"
PLUGIN_NAME="copilot"
MARKETPLACE_NAME="naicud-copilotcli-plugin-cc"
BRANCH="main"

case "${1:-}" in
  -h|--help)
    echo "usage: install.sh"
    exit 0
    ;;
  "") ;;
  *)
    echo "unknown argument: $1" >&2
    exit 2
    ;;
esac

CLAUDE_DIR="$HOME/.claude"
MARKETPLACES_DIR="$CLAUDE_DIR/plugins/marketplaces"
CACHE_DIR="$CLAUDE_DIR/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME"
KNOWN_MKT="$CLAUDE_DIR/plugins/known_marketplaces.json"
INSTALLED="$CLAUDE_DIR/plugins/installed_plugins.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[copilot-plugin]${NC} $1"; }
warn()  { echo -e "${YELLOW}[copilot-plugin]${NC} $1"; }
error() { echo -e "${RED}[copilot-plugin]${NC} $1"; exit 1; }

[ -d "$CLAUDE_DIR" ] || error "Claude Code directory not found at $CLAUDE_DIR. Is Claude Code installed?"
command -v node >/dev/null 2>&1 || error "node not found on PATH. Install Node.js 18.18 or later."
command -v python3 >/dev/null 2>&1 || error "python3 not found on PATH. It is needed to update the plugin registry."
command -v copilot >/dev/null 2>&1 || warn "GitHub Copilot CLI not found on PATH. Install it later with: npm install -g @github/copilot"
mkdir -p "$MARKETPLACES_DIR" "$CLAUDE_DIR/plugins/cache"

# --- Step 1: Clone (or refresh) the marketplace ---
MKT_DIR="$MARKETPLACES_DIR/$MARKETPLACE_NAME"
if [ -d "$MKT_DIR" ]; then
  info "Marketplace already exists, pulling latest..."
  git -C "$MKT_DIR" pull --ff-only origin "$BRANCH" 2>/dev/null || true
else
  info "Cloning marketplace from GitHub..."
  if git clone --depth 1 -b "$BRANCH" "git@github.com:$REPO.git" "$MKT_DIR" 2>/dev/null; then
    info "Cloned via SSH."
  elif git clone --depth 1 -b "$BRANCH" "https://github.com/$REPO.git" "$MKT_DIR" 2>/dev/null; then
    info "Cloned via HTTPS."
  else
    error "Failed to clone repository. Please check your network and GitHub access."
  fi
fi

# --- Step 2: Read plugin version ---
PLUGIN_JSON="$MKT_DIR/plugins/$PLUGIN_NAME/.claude-plugin/plugin.json"
[ -f "$PLUGIN_JSON" ] || error "plugin.json not found at $PLUGIN_JSON"
VERSION=$(python3 -c "import json; print(json.load(open('$PLUGIN_JSON'))['version'])" 2>/dev/null || echo "0.0.0")
GIT_SHA=$(git -C "$MKT_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
info "Plugin version: $VERSION (sha: ${GIT_SHA:0:12})"

# --- Step 3: Copy plugin to cache ---
CACHE_VERSION_DIR="$CACHE_DIR/$VERSION"
rm -rf "$CACHE_VERSION_DIR"
mkdir -p "$CACHE_VERSION_DIR"
cp -R "$MKT_DIR/plugins/$PLUGIN_NAME/." "$CACHE_VERSION_DIR/"
info "Plugin cached at $CACHE_VERSION_DIR"

# --- Step 4: Register marketplace in known_marketplaces.json ---
[ -f "$KNOWN_MKT" ] || echo '{}' > "$KNOWN_MKT"
python3 -c "
import json
with open('$KNOWN_MKT', 'r') as f:
    data = json.load(f)
data['$MARKETPLACE_NAME'] = {
    'source': {'source': 'github', 'repo': '$REPO'},
    'installLocation': '$MKT_DIR',
    'lastUpdated': '$NOW'
}
with open('$KNOWN_MKT', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" || warn "Could not update known_marketplaces.json (non-fatal)"

# --- Step 5: Register plugin in installed_plugins.json ---
[ -f "$INSTALLED" ] || echo '{"version": 2, "plugins": {}}' > "$INSTALLED"
python3 -c "
import json
with open('$INSTALLED', 'r') as f:
    data = json.load(f)
data.setdefault('plugins', {})
data['plugins']['$PLUGIN_NAME@$MARKETPLACE_NAME'] = [{
    'scope': 'user',
    'installPath': '$CACHE_VERSION_DIR',
    'version': '$VERSION',
    'installedAt': '$NOW',
    'lastUpdated': '$NOW',
    'gitCommitSha': '$GIT_SHA'
}]
with open('$INSTALLED', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" || error "Failed to update installed_plugins.json"

echo ""
info "Installation complete."
echo ""
echo -e "  ${GREEN}Next step:${NC} run this inside Claude Code:"
echo ""
echo -e "    ${YELLOW}/reload-plugins${NC}"
echo ""
echo -e "  Then verify with:"
echo ""
echo -e "    ${YELLOW}/copilot:setup${NC}"
echo ""
