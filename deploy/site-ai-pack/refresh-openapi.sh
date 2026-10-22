#!/usr/bin/env bash
# Refresh the pack's OpenAPI copy from the gateway's own source.
#
# Usage:  deploy/site-ai-pack/refresh-openapi.sh <path-to-abetapi-repo>
#
# WHY THIS EXISTS
#
# The site advertises an OpenAPI contract, and the copy the pack ships went
# stale: it was two versions behind and did not carry the NuCRM inbound
# bridge — the one endpoint the suite's compatibility story rests on. A
# contract an integrator reads and finds missing is worse than no contract.
#
# So the copy is refreshed from the gateway's own generator (the same function
# that serves /api/v1/openapi), and the pack itself prefers the live contract
# when it can reach it. This script is how the copy stays right between deploys.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${1:?usage: refresh-openapi.sh <path-to-abetapi-repo>}"
if [ ! -d "$REPO" ]; then
  echo "error: $REPO is not a directory" >&2
  exit 1
fi

OUT="$HERE/files/openapi.json"
TMP="$(mktemp)"

# The gateway's own generator, run against its own tree.
(cd "$REPO" && npx tsx -e '
  import { openapiSpec } from "./src/lib/openapi";
  process.stdout.write(JSON.stringify(openapiSpec, null, 2) + "\n");
') > "$TMP"

node -e '
  const fs = require("node:fs");
  const spec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const paths = Object.keys(spec.paths ?? {});
  if (paths.length === 0) { console.error("the generated contract has no paths"); process.exit(1); }
  console.log(`the gateway contract: ${spec.info?.version} — ${paths.length} paths`);
  console.log(`  ${paths.join(" ")}`);
' "$TMP"

cp "$TMP" "$OUT"
rm -f "$TMP"
echo "refreshed: $OUT"
