#!/usr/bin/env bash
set -euo pipefail
# Native checkout fetches all branch refs without persisting the GitHub App credential.
[[ "$BUILD_SOURCEBRANCH" == refs/heads/main ]] || exit 1
[[ "$BUILD_SOURCEVERSION" =~ ^[a-f0-9]{40}$ ]] || exit 1
test "$(git rev-parse HEAD)" = "$BUILD_SOURCEVERSION" || exit 1
test "$(git rev-parse refs/remotes/origin/main)" = "$BUILD_SOURCEVERSION" || exit 1
