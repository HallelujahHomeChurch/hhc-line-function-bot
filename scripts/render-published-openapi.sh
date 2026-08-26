#!/usr/bin/env bash
set -euo pipefail

source_spec="${1:?source OpenAPI path is required}"
published_spec="${2:?published OpenAPI path is required}"

npx --yes @redocly/cli@2.47.0 bundle "$source_spec" --ext yaml --output "$published_spec"
if grep -Eq '^[[:space:]]*<<:' "$published_spec"; then
  echo "Published OpenAPI still contains YAML merge keys" >&2
  exit 1
fi
npx --yes @redocly/cli@2.47.0 lint "$published_spec"
