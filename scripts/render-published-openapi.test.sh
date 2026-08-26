#!/usr/bin/env bash
set -euo pipefail

temp_dir="$(mktemp -d)"
output="$temp_dir/openapi.yaml"
trap 'rm -rf "$temp_dir"' EXIT

bash scripts/render-published-openapi.sh docs/openapi.yaml "$output"
if grep -Eq '^[[:space:]]*<<:' "$output"; then
  echo "Rendered OpenAPI contains YAML merge keys" >&2
  exit 1
fi
npx --yes @redocly/cli@2.47.0 lint "$output"
ruby -e 'require "yaml"; d=YAML.safe_load(File.read(ARGV[0]), aliases: false); d.fetch("paths").each_value { |p| p.each_value { |o| abort "Rendered OpenAPI contains a response named <<" if o.is_a?(Hash) && o.fetch("responses", {}).key?("<<") } }' "$output"
