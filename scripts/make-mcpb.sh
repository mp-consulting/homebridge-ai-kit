#!/bin/sh
# Packs the MCP server into a Claude app extension (.mcpb): double-click to install in Claude.
#   scripts/make-mcpb.sh [output]   (default: dist-mcpb/homebridge-ai-kit-<version>.mcpb)
# Bundles this checkout's ai-kit and ai-core (as npm would publish them) with their production
# dependencies, so the extension runs on Claude's own Node without npx or a network install.
# Needs Node and npm; the packer is the official @anthropic-ai/mcpb.
set -eu
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
OUT="${1:-dist-mcpb/homebridge-ai-kit-$VERSION.mcpb}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

npm run build >/dev/null
mkdir -p "$STAGE/tarballs" "$STAGE/bundle/server" "$(dirname "$OUT")"
npm pack --silent --pack-destination "$STAGE/tarballs" -w packages/ai-core >/dev/null
npm pack --silent --pack-destination "$STAGE/tarballs" >/dev/null
echo '{ "private": true }' > "$STAGE/bundle/server/package.json"
(cd "$STAGE/bundle/server" && npm install --silent --omit=dev --no-audit --no-fund --no-package-lock "$STAGE"/tarballs/*.tgz)
rm "$STAGE/bundle/server/package.json"

TOOLS="$(node scripts/mcpb-tools.mjs)"
node -e '
  const fs = require("fs");
  const [out, version, tools] = process.argv.slice(1);
  const text = fs.readFileSync("mcpb/manifest.json", "utf8").replace("__VERSION__", version).replace("__TOOLS__", tools);
  fs.writeFileSync(out, JSON.stringify(JSON.parse(text), null, 2) + "\n");
' "$STAGE/bundle/manifest.json" "$VERSION" "$TOOLS"

npx --yes @anthropic-ai/mcpb@2.1.2 validate "$STAGE/bundle/manifest.json"
rm -f "$OUT"
npx --yes @anthropic-ai/mcpb@2.1.2 pack "$STAGE/bundle" "$OUT"
echo "Built $OUT"
