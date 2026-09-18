#!/usr/bin/env bash

set -euo pipefail

compose_file="docker-compose.stage-test.yaml"
secrets_file=".env.stage"
required_free_kb=$((1024 * 1024))
lite_image="stage-dittofeed-lite:v0.24.0-alpha.17-stage-ui9"

if [[ ! -f "$compose_file" ]]; then
  echo "Run this script from the Dittofeed repository root." >&2
  exit 1
fi

for command_name in docker grep openssl sed; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is missing: $command_name" >&2
    exit 1
  fi
done

available_kb=$(df -Pk / | awk 'NR == 2 {print $4}')
if (( available_kb < required_free_kb )); then
  echo "At least 1 GiB of free disk is required before deployment." >&2
  exit 1
fi

if ! docker image inspect "$lite_image" >/dev/null 2>&1; then
  echo "Required prebuilt image is missing: $lite_image" >&2
  exit 1
fi

if [[ ! -f "$secrets_file" ]]; then
  umask 077
  temporary_secrets=$(mktemp "${secrets_file}.XXXXXX")
  trap 'rm -f "$temporary_secrets"' EXIT
  : >"$temporary_secrets"
  mv "$temporary_secrets" "$secrets_file"
  trap - EXIT
fi

chmod 600 "$secrets_file"

ensure_secret() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" "$secrets_file"; then
    printf '%s=%s\n' "$key" "$value" >>"$secrets_file"
  fi
}

ensure_secret DATABASE_USER dittofeed_stage
ensure_secret DATABASE_PASSWORD "$(openssl rand -hex 24)"
ensure_secret CLICKHOUSE_USER dittofeed_stage
ensure_secret CLICKHOUSE_PASSWORD "$(openssl rand -hex 24)"
ensure_secret PASSWORD "$(openssl rand -hex 12)"
ensure_secret SECRET_KEY "$(openssl rand -base64 32)"

source_clickhouse_env="${SOURCE_CLICKHOUSE_ENV_FILE:-/home/ubuntu/stage-engage/.env}"
copy_source_secret() {
  local target_key="$1"
  local source_key="$2"
  local value=""
  if grep -q "^${target_key}=" "$secrets_file"; then
    return
  fi
  if [[ ! -f "$source_clickhouse_env" ]]; then
    echo "Missing source ClickHouse configuration: $source_clickhouse_env" >&2
    exit 1
  fi
  value=$(bash -c 'set -a; source "$1"; key="$2"; printf "%s" "${!key-}"' _ "$source_clickhouse_env" "$source_key")
  if [[ -z "$value" ]]; then
    echo "Missing $source_key in $source_clickhouse_env" >&2
    exit 1
  fi
  ensure_secret "$target_key" "$value"
}

copy_source_secret SOURCE_CLICKHOUSE_HOST CH_HOST
copy_source_secret SOURCE_CLICKHOUSE_PORT CH_PORT
copy_source_secret SOURCE_CLICKHOUSE_SECURE CH_SECURE
copy_source_secret SOURCE_CLICKHOUSE_USER CH_USER
copy_source_secret SOURCE_CLICKHOUSE_PASSWORD CH_PASSWORD

set -a
# shellcheck disable=SC1090
source "$secrets_file"
set +a

compose=(docker compose --env-file "$secrets_file" -f "$compose_file")
export BOOTSTRAP=false
"${compose[@]}" config --quiet

if [[ "${PREPARE_ONLY:-false}" == "true" ]]; then
  echo "Stage deployment secrets and compose configuration are ready."
  exit 0
fi

"${compose[@]}" pull postgres temporal clickhouse
"${compose[@]}" up -d --wait --wait-timeout 300 postgres clickhouse temporal

existing_workspace=$(
  docker exec stage-dittofeed-postgres psql -U "$DATABASE_USER" \
    -d dittofeed_stage_test -Atc \
    "select 1 from \"Workspace\" where name = 'STAGE Dittofeed Test' limit 1;" \
    2>/dev/null || true
)

if [[ "$existing_workspace" != "1" ]]; then
  export BOOTSTRAP=true
  "${compose[@]}" up -d --wait --wait-timeout 300
  export BOOTSTRAP=false
fi
"${compose[@]}" up -d --wait --wait-timeout 300

write_key=$(
  docker exec stage-dittofeed-postgres psql -U "$DATABASE_USER" \
    -d dittofeed_stage_test -Atc \
    "select 'Basic ' || encode(convert_to(s.id::text || ':' || s.value, 'UTF8'), 'base64') from \"WriteKey\" w join \"Secret\" s on s.id = w.\"secretId\" order by w.\"createdAt\" limit 1;"
)
if [[ "$write_key" != "Basic "* ]]; then
  echo "Unable to resolve the Dittofeed public write key." >&2
  exit 1
fi
ensure_secret DITTOFEED_WRITE_KEY "\"$write_key\""
export DITTOFEED_WRITE_KEY="$write_key"
"${compose[@]}" up -d --wait --wait-timeout 300 selective-stream
"${compose[@]}" ps
