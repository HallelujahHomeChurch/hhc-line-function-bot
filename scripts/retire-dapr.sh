#!/usr/bin/env bash
set -euo pipefail

: "${RESOURCE_GROUP:?}" "${EXPECTED_GATEWAY_IMAGE:?}" "${EXPECTED_LINE_IMAGE:?}" "${LINE_GATEWAY_PRIVATE_TOKEN_VERSION:?}"
[[ "${EXPECTED_GATEWAY_IMAGE}" =~ ^alive\.azurecr\.io/alive/api-gateway@sha256:[a-f0-9]{64}$ ]]
[[ "${EXPECTED_LINE_IMAGE}" =~ ^alive\.azurecr\.io/alive/hhc-line-function-bot@sha256:[a-f0-9]{64}$ ]]
[[ "${LINE_GATEWAY_PRIVATE_TOKEN_VERSION}" =~ ^[a-f0-9]{32}$ ]]
token_ref="https://alive-vault.vault.azure.net/secrets/line-gateway-private-token/${LINE_GATEWAY_PRIVATE_TOKEN_VERSION}"

read_app() {
  az containerapp show -g "${RESOURCE_GROUP}" -n "$1" --only-show-errors -o json \
    --query "{latest:properties.latestRevisionName,ready:properties.latestReadyRevisionName,image:properties.template.containers[0].image,ingress:properties.configuration.ingress,dapr:properties.configuration.dapr,token:properties.configuration.secrets[?name=='line-gateway-private-token'].keyVaultUrl,env:properties.template.containers[0].env[?name=='LINE_GATEWAY_PRIVATE_TOKEN'||name=='OPERATIONS_LINE_PRIVATE_TOKEN'||name=='OPERATIONS_PRIVATE_BASE_URL'||name=='ACCOUNT_LINE_PRIVATE_TOKEN'||name=='ACCOUNT_API_BASE_URL'||name=='CMS_LINE_PRIVATE_TOKEN'||name=='CMS_PRIVATE_BASE_URL'||name=='ASSET_API_BASE_URL'||name=='AUDIT_PRIVATE_BASE_URL']}"
}

verify_serving() {
  local name="$1" expected_image="$2" state="$3" revision
  revision="$(jq -er --arg image "$expected_image" --arg uri "$token_ref" '
    .ready as $revision |
    select(.latest == .ready and (.ready | type == "string") and .image == $image and
      .token == [$uri] and ([.env[] | select(.name=="LINE_GATEWAY_PRIVATE_TOKEN").secretRef] == ["line-gateway-private-token"]) and
      ([.ingress.traffic[] | select(.weight > 0)] | length == 1) and
      any(.ingress.traffic[]; .weight == 100 and (.latestRevision == true or .revisionName == $revision)))
    | .ready' <<<"$state")" || return 1
  [[ "$revision" =~ ^${name}--[a-z0-9-]+$ ]] || return 1
  az containerapp revision show -g "${RESOURCE_GROUP}" -n "$name" --revision "$revision" --only-show-errors -o json \
    --query '{active:properties.active,health:properties.healthState,provisioning:properties.provisioningState,running:properties.runningState,image:properties.template.containers[0].image}' |
    jq -e --arg image "$expected_image" '.active == true and .health == "Healthy" and .provisioning == "Provisioned" and
      (.running == "Running" or .running == "RunningAtMaxScale") and .image == $image' >/dev/null
}

verify_line_bindings() {
  jq -e --arg image "${EXPECTED_LINE_IMAGE}" '
    def origin($key; $app):
      any(.env[]; .name == $key and (.value | test("^https://"+$app+"[.]internal[.][a-z0-9-]+[.][a-z0-9-]+[.]azurecontainerapps[.]io$")));
    .image == $image and .ingress.external == false and .ingress.allowInsecure == false and
    .ingress.targetPort == 3000 and ((.ingress.transport | ascii_downcase) == "auto") and
    ([.env[] | select(.name == "OPERATIONS_LINE_PRIVATE_TOKEN").secretRef] == ["operations-line-private-token"]) and
    ([.env[] | select(.name == "ACCOUNT_LINE_PRIVATE_TOKEN").secretRef] == ["account-line-private-token"]) and
    ([.env[] | select(.name == "CMS_LINE_PRIVATE_TOKEN").secretRef] == ["cms-line-private-token"]) and
    origin("OPERATIONS_PRIVATE_BASE_URL"; "operations-api") and origin("ACCOUNT_API_BASE_URL"; "account-api") and
    origin("CMS_PRIVATE_BASE_URL"; "hhc-web-api") and origin("ASSET_API_BASE_URL"; "asset-api") and
    origin("AUDIT_PRIVATE_BASE_URL"; "audit-log")
  ' >/dev/null
}

probe_webhook() {
  local body status
  body="$(mktemp)"
  if ! status="$(curl --silent --show-error --max-time 15 --output "$body" --write-out '%{http_code}' \
    --header 'Content-Type: application/json' --data-binary '{"events":[]}' \
    'https://www.alive.org.tw/api/line/webhook/helper')" ||
    [[ "$status" != 400 ]] ||
    ! jq -e '.ok == false and .error == "missing_line_signature"' "$body" >/dev/null; then
    rm -f "$body"
    return 1
  fi
  rm -f "$body"
}

line_app=hhc-line-function-bot
gateway="$(read_app api-gateway)"
verify_serving api-gateway "${EXPECTED_GATEWAY_IMAGE}" "$gateway"
line="$(read_app "$line_app")"
verify_serving "$line_app" "${EXPECTED_LINE_IMAGE}" "$line"
verify_line_bindings <<<"$line"
probe_webhook
if jq -e '.dapr.enabled == false' <<<"$line" >/dev/null; then
  echo 'The pinned LINE image already serves without Dapr.'
  exit 0
fi
jq -e '.dapr.enabled == true and .dapr.appId == "hhc-line-function-bot" and .dapr.appPort == 3000 and
  .dapr.appProtocol == "http" and .dapr.logLevel == "warn"' <<<"$line" >/dev/null

wait_for_line() {
  local mode="$1" current attempt
  for ((attempt=0; attempt<18; attempt++)); do
    if current="$(read_app "$line_app")" && jq -e --argjson enabled "$mode" '.dapr.enabled == $enabled' <<<"$current" >/dev/null &&
      verify_line_bindings <<<"$current" && verify_serving "$line_app" "${EXPECTED_LINE_IMAGE}" "$current"; then
      return 0
    fi
    sleep 10
  done
  return 1
}

if az containerapp dapr disable -g "${RESOURCE_GROUP}" -n "$line_app" --only-show-errors -o none &&
   wait_for_line false &&
   gateway="$(read_app api-gateway)" && verify_serving api-gateway "${EXPECTED_GATEWAY_IMAGE}" "$gateway" &&
   probe_webhook; then
  echo 'The pinned LINE image is serving without Dapr.'
  exit 0
fi

if line="$(read_app "$line_app")" && jq -e --arg image "${EXPECTED_LINE_IMAGE}"   '.image == $image and .dapr.enabled == false' <<<"$line" >/dev/null; then
  az containerapp dapr enable -g "${RESOURCE_GROUP}" -n "$line_app" --dapr-app-id "$line_app" \
    --dapr-app-port 3000 --dapr-app-protocol http --dapr-log-level warn --only-show-errors -o none
  wait_for_line true && probe_webhook && echo 'The previous LINE Dapr configuration was restored.'
fi
exit 1
