#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${RITSDEV_URL:?set RITSDEV_URL to the platform base URL, e.g. https://sites.example.org}"
TOKEN="${RITSDEV_TOKEN:?Set RITSDEV_TOKEN to a scoped personal access token}"

curl --fail --silent --show-error "${BASE_URL}/healthz" >/dev/null
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${TOKEN}" \
  "${BASE_URL}/v1/me" >/dev/null

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"conformance","version":"1"}}}' \
  "${BASE_URL}/mcp" |
  grep -q '"serverInfo"'

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  "${BASE_URL}/mcp" |
  grep -q '"create_project"'

echo "Control-plane and MCP smoke checks passed."
echo "This is not launch certification. Complete every isolation, storage, backup, and capacity gate in docs/operations.md."
