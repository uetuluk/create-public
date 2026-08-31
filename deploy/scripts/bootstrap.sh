#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT}/deploy/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing deploy/.env. Copy deploy/.env.example and fill every required value." >&2
  exit 1
fi

cd "${ROOT}/deploy"
COMPOSE_ENV="$(docker compose --env-file "${ENV_FILE}" config --environment)"
env_value() {
  local key="$1"
  awk -v prefix="${key}=" 'index($0, prefix) == 1 {sub(prefix, ""); print; exit}' <<<"${COMPOSE_ENV}"
}

usable_operator_value() {
  local value="$1"
  [[ -n "${value}" &&
     "${value}" != replace* &&
     "${value}" != change-me* &&
     "${value}" != your-* ]]
}

for required_external in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET CLOUDFLARE_API_TOKEN CLOUDFLARE_TUNNEL_TOKEN; do
  if ! usable_operator_value "$(env_value "${required_external}")"; then
    echo "${required_external} must be replaced with its operator-provided value." >&2
    exit 1
  fi
done

DATA_HOST_ROOT="$(env_value DATA_HOST_ROOT)"
: "${DATA_HOST_ROOT:?DATA_HOST_ROOT must be set in deploy/.env}"
if [[ "${DATA_HOST_ROOT}" != /* || "${DATA_HOST_ROOT}" == "/" ]]; then
  echo "DATA_HOST_ROOT must be an absolute, dedicated directory (not /)." >&2
  exit 1
fi

PLATFORM_UID="$(env_value PLATFORM_UID)"
PLATFORM_GID="$(env_value PLATFORM_GID)"
if ! [[ "${PLATFORM_UID}" =~ ^[0-9]+$ && "${PLATFORM_GID}" =~ ^[0-9]+$ ]]; then
  echo "PLATFORM_UID and PLATFORM_GID must be numeric deployment-account IDs." >&2
  exit 1
fi

OAUTH_PRIVATE_KEY_HOST_FILE="$(env_value OAUTH_PRIVATE_KEY_HOST_FILE)"
OAUTH_PUBLIC_KEY_HOST_FILE="$(env_value OAUTH_PUBLIC_KEY_HOST_FILE)"
for key_file in "${OAUTH_PRIVATE_KEY_HOST_FILE}" "${OAUTH_PUBLIC_KEY_HOST_FILE}"; do
  if [[ "${key_file}" != /* || ! -r "${key_file}" ]]; then
    echo "OAuth signing key file must be an absolute readable file: ${key_file}" >&2
    exit 1
  fi
done

SESSION_SECRET="$(env_value PLATFORM_SESSION_SECRET)"
ENCRYPTION_SECRET="$(env_value SECRET_ENCRYPTION_KEY)"
EDGE_SECRET="$(env_value EDGE_PROXY_SECRET)"
for secret_name in SESSION_SECRET ENCRYPTION_SECRET EDGE_SECRET; do
  secret_value="${!secret_name}"
  if (( ${#secret_value} < 32 )) ||
     [[ "${secret_value}" == *change-me* || "${secret_value}" == *replace* || "${secret_value}" == your-* ]]; then
    echo "${secret_name} must be an independent random value of at least 32 characters." >&2
    exit 1
  fi
done
if [[ "${SESSION_SECRET}" == "${ENCRYPTION_SECRET}" ||
      "${SESSION_SECRET}" == "${EDGE_SECRET}" ||
      "${ENCRYPTION_SECRET}" == "${EDGE_SECRET}" ]]; then
  echo "Session, encryption, and edge-proxy secrets must all be different." >&2
  exit 1
fi

mkdir -p \
  "${DATA_HOST_ROOT}/platform" \
  "${DATA_HOST_ROOT}/postgres" \
  "${DATA_HOST_ROOT}/rustfs" \
  "${DATA_HOST_ROOT}/caddy/data" \
  "${DATA_HOST_ROOT}/caddy/config" \
  "${DATA_HOST_ROOT}/caddy/logs"

docker compose --env-file "${ENV_FILE}" config --quiet

# Job images are launched on demand by the executor, so without this the first
# build, cold start, or render on a fresh host pays the pull cost inside a
# request. The render endpoint only waits 30 seconds, and the Playwright image
# is roughly 2 GB, so an unpulled image reads to the caller as a failed render.
# Read the resolved values rather than deploy/.env, because these pins live in
# compose defaults and are usually absent from the environment file.
RESOLVED_CONFIG="$(docker compose --env-file "${ENV_FILE}" config)"
while read -r image; do
  [[ -n "${image}" ]] || continue
  echo "Pre-pulling ${image%%@*}"
  docker pull --quiet "${image}"
done < <(
  awk -F': +' '/^ +(NODE_BUILD_IMAGE|DENO_RUNTIME_IMAGE|PLAYWRIGHT_IMAGE): /{gsub(/"/, "", $2); print $2}' \
    <<<"${RESOLVED_CONFIG}" | sort -u
)

docker compose --env-file "${ENV_FILE}" build platform caddy
docker compose --env-file "${ENV_FILE}" up -d postgres pgbouncer rustfs platform gateway executor caddy
"${ROOT}/deploy/scripts/install-egress-firewall.sh"
docker compose --env-file "${ENV_FILE}" ps

echo
echo "Core platform started."
echo "Run deploy/scripts/conformance.sh before enabling the Cloudflare Tunnel."
echo "Start the root-only public tunnel with: docker compose --profile public up -d cloudflared"
