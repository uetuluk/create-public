#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT}/deploy/.env"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${ROOT}/deploy/.env.pre-sites-v1.${TIMESTAMP}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing deploy/.env; copy deploy/.env.example instead." >&2
  exit 1
fi

umask 077

needs_legacy_backup=0
if grep -Eq '^(MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|PLATFORM_JWT_SECRET)=' "${ENV_FILE}" ||
   ! grep -Eq '^SECRET_ENCRYPTION_KEY=' "${ENV_FILE}"; then
  needs_legacy_backup=1
fi

env_value() {
  local key="$1"
  awk -v key="${key}" '
    $0 ~ "^[[:space:]]*" key "=" {
      sub("^[[:space:]]*" key "=", "")
      print
      exit
    }
  ' "${ENV_FILE}"
}

first_nonempty() {
  local value
  for value in "$@"; do
    if [[ -n "${value}" ]]; then
      printf '%s' "${value}"
      return
    fi
  done
}

random_hex() {
  openssl rand -hex 32
}

usable_operator_value() {
  local value="$1"
  [[ -n "${value}" &&
     "${value}" != replace* &&
     "${value}" != change-me* &&
     "${value}" != your-* ]]
}

detect_lan_ip() {
  local value=""
  if command -v ipconfig >/dev/null 2>&1; then
    value="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  if [[ -z "${value}" ]] && command -v ifconfig >/dev/null 2>&1; then
    value="$(ifconfig en0 2>/dev/null | awk '$1 == "inet" {print $2; exit}' || true)"
  fi
  if [[ -z "${value}" ]] && command -v hostname >/dev/null 2>&1; then
    value="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [[ "${value}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s' "${value}"
  else
    printf '127.0.0.1'
  fi
}

cidr_for_ip() {
  local ip="$1"
  local a b c _
  IFS=. read -r a b c _ <<<"${ip}"
  if [[ "${a}" == "100" && "${b}" -ge 64 && "${b}" -le 127 ]]; then
    printf '100.64.0.0/10'
  elif [[ "${ip}" == "127."* ]]; then
    printf '127.0.0.0/8'
  else
    printf '%s.%s.%s.0/24' "${a}" "${b}" "${c}"
  fi
}

postgres_user="$(first_nonempty "$(env_value POSTGRES_USER)" "postgres")"
postgres_password="$(first_nonempty "$(env_value POSTGRES_PASSWORD)" "$(random_hex)")"
rustfs_access_key="$(first_nonempty "$(env_value RUSTFS_ACCESS_KEY)" "$(env_value MINIO_ROOT_USER)" "ritsdevadmin")"
rustfs_secret_key="$(first_nonempty "$(env_value RUSTFS_SECRET_KEY)" "$(env_value MINIO_ROOT_PASSWORD)" "$(random_hex)")"
platform_session_secret="$(first_nonempty "$(env_value PLATFORM_SESSION_SECRET)" "$(env_value PLATFORM_JWT_SECRET)" "$(random_hex)")"
secret_encryption_key="$(first_nonempty "$(env_value SECRET_ENCRYPTION_KEY)" "$(random_hex)")"
edge_proxy_secret="$(first_nonempty "$(env_value EDGE_PROXY_SECRET)" "$(random_hex)")"
cloudflare_api_token="$(first_nonempty "$(env_value CLOUDFLARE_API_TOKEN)" "replace")"
cloudflare_tunnel_token="$(first_nonempty "$(env_value CLOUDFLARE_TUNNEL_TOKEN)" "replace")"
google_client_id="$(first_nonempty "$(env_value GOOGLE_CLIENT_ID)" "replace.apps.googleusercontent.com")"
google_client_secret="$(first_nonempty "$(env_value GOOGLE_CLIENT_SECRET)" "replace")"
if ! usable_operator_value "${cloudflare_api_token}"; then cloudflare_api_token="replace"; fi
if ! usable_operator_value "${cloudflare_tunnel_token}"; then cloudflare_tunnel_token="replace"; fi
if ! usable_operator_value "${google_client_id}"; then google_client_id="replace.apps.googleusercontent.com"; fi
if ! usable_operator_value "${google_client_secret}"; then google_client_secret="replace"; fi
data_host_root="$(first_nonempty "${DATA_HOST_ROOT_OVERRIDE:-}" "$(env_value DATA_HOST_ROOT)" "${ROOT}/data")"
if [[ -n "${PLATFORM_UID_OVERRIDE:-}" ]]; then
  platform_uid="${PLATFORM_UID_OVERRIDE}"
elif [[ -n "${DATA_HOST_ROOT_OVERRIDE:-}" || -n "${OAUTH_KEY_DIR_OVERRIDE:-}" ]]; then
  platform_uid="$(id -u)"
else
  platform_uid="$(first_nonempty "$(env_value PLATFORM_UID)" "$(id -u)")"
fi
if [[ -n "${PLATFORM_GID_OVERRIDE:-}" ]]; then
  platform_gid="${PLATFORM_GID_OVERRIDE}"
elif [[ -n "${DATA_HOST_ROOT_OVERRIDE:-}" || -n "${OAUTH_KEY_DIR_OVERRIDE:-}" ]]; then
  platform_gid="$(id -g)"
else
  platform_gid="$(first_nonempty "$(env_value PLATFORM_GID)" "$(id -g)")"
fi
if ! [[ "${platform_uid}" =~ ^[0-9]+$ && "${platform_gid}" =~ ^[0-9]+$ ]]; then
  echo "PLATFORM_UID and PLATFORM_GID must be numeric." >&2
  exit 1
fi
existing_lan_bind_ip="$(env_value LAN_BIND_IP)"
detected_lan_bind_ip="$(detect_lan_ip)"
if [[ -n "${LAN_BIND_IP_OVERRIDE:-}" ]]; then
  lan_bind_ip="${LAN_BIND_IP_OVERRIDE}"
elif [[ -n "${existing_lan_bind_ip}" && "${existing_lan_bind_ip}" != "127.0.0.1" ]]; then
  lan_bind_ip="${existing_lan_bind_ip}"
else
  lan_bind_ip="${detected_lan_bind_ip}"
fi
existing_network_cidrs="$(env_value NETWORK_CIDRS)"
if [[ -n "${NETWORK_CIDRS_OVERRIDE:-}" ]]; then
  network_cidrs="${NETWORK_CIDRS_OVERRIDE}"
elif [[ -n "${existing_network_cidrs}" && "${existing_network_cidrs}" != "127.0.0.0/8" ]]; then
  network_cidrs="${existing_network_cidrs}"
else
  network_cidrs="$(cidr_for_ip "${lan_bind_ip}")"
fi
gateway_domain="$(env_value GATEWAY_DOMAIN)"
public_base_url="$(env_value PUBLIC_BASE_URL)"
cloudflared_image="$(first_nonempty "$(env_value CLOUDFLARED_IMAGE)" "cloudflare/cloudflared:2026.7.2@sha256:4f6655284ab3d252b7f28fedb19fe6c8fc82ee5b1295c20ac74d475e5398a52d")"
node_build_image="$(first_nonempty "$(env_value NODE_BUILD_IMAGE)" "node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd")"
deno_runtime_image="$(first_nonempty "$(env_value DENO_RUNTIME_IMAGE)" "denoland/deno:2.9.4@sha256:c777b4b225501a61074837e90a826a58f99124837824023cd60334b1e2374498")"
# Built from deploy/render; the upstream image lacks the playwright npm
# package. Any pre-existing upstream pin is rewritten, because using it
# directly makes every render fail with "Cannot find module 'playwright'".
playwright_image="$(first_nonempty "$(env_value PLAYWRIGHT_IMAGE)" "ritsdev-render:local")"
case "${playwright_image}" in
  mcr.microsoft.com/playwright*) playwright_image="ritsdev-render:local" ;;
esac

strong_secret() {
  local value="$1"
  [[ ${#value} -ge 32 && "${value}" != *change-me* && "${value}" != *replace* ]]
}

if ! strong_secret "${platform_session_secret}"; then
  platform_session_secret="$(random_hex)"
fi
if ! strong_secret "${secret_encryption_key}" || [[ "${secret_encryption_key}" == "${platform_session_secret}" ]]; then
  secret_encryption_key="$(random_hex)"
fi
if ! strong_secret "${edge_proxy_secret}" ||
   [[ "${edge_proxy_secret}" == "${platform_session_secret}" || "${edge_proxy_secret}" == "${secret_encryption_key}" ]]; then
  edge_proxy_secret="$(random_hex)"
fi

if [[ "${data_host_root}" != /* || "${data_host_root}" == "/" ]]; then
  echo "Refusing unsafe DATA_HOST_ROOT: it must be an absolute dedicated path." >&2
  exit 1
fi

key_dir="$(first_nonempty "${OAUTH_KEY_DIR_OVERRIDE:-}" "${data_host_root}/keys")"
if [[ -n "${DATA_HOST_ROOT_OVERRIDE:-}" || -n "${OAUTH_KEY_DIR_OVERRIDE:-}" ]]; then
  private_key="${key_dir}/oauth-private.pem"
  public_key="${key_dir}/oauth-public.pem"
else
  private_key="$(first_nonempty "$(env_value OAUTH_PRIVATE_KEY_HOST_FILE)" "${key_dir}/oauth-private.pem")"
  public_key="$(first_nonempty "$(env_value OAUTH_PUBLIC_KEY_HOST_FILE)" "${key_dir}/oauth-public.pem")"
fi
mkdir -p "${key_dir}" "$(dirname "${private_key}")" "$(dirname "${public_key}")"
chmod 700 "${key_dir}"
if [[ ! -f "${private_key}" ]]; then
  openssl genpkey -quiet -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${private_key}"
fi
if [[ ! -f "${public_key}" ]]; then
  openssl rsa -pubout -in "${private_key}" -out "${public_key}" >/dev/null 2>&1
fi
chmod 600 "${private_key}"
chmod 644 "${public_key}"

if (( needs_legacy_backup )); then
  cp -p "${ENV_FILE}" "${BACKUP_FILE}"
  chmod 600 "${BACKUP_FILE}"
fi

new_env="$(mktemp "${ENV_FILE}.new.XXXXXX")"
trap 'rm -f "${new_env}"' EXIT
{
  printf 'DATA_HOST_ROOT=%s\n\n' "${data_host_root}"
  printf 'PLATFORM_UID=%s\n' "${platform_uid}"
  printf 'PLATFORM_GID=%s\n\n' "${platform_gid}"
  printf 'POSTGRES_USER=%s\n' "${postgres_user}"
  printf 'POSTGRES_PASSWORD=%s\n\n' "${postgres_password}"
  printf 'RUSTFS_ACCESS_KEY=%s\n' "${rustfs_access_key}"
  printf 'RUSTFS_SECRET_KEY=%s\n\n' "${rustfs_secret_key}"
  printf 'PLATFORM_SESSION_SECRET=%s\n' "${platform_session_secret}"
  printf 'SECRET_ENCRYPTION_KEY=%s\n' "${secret_encryption_key}"
  printf 'EDGE_PROXY_SECRET=%s\n\n' "${edge_proxy_secret}"
  printf 'OAUTH_PRIVATE_KEY_HOST_FILE=%s\n' "${private_key}"
  printf 'OAUTH_PUBLIC_KEY_HOST_FILE=%s\n\n' "${public_key}"
  printf 'GOOGLE_CLIENT_ID=%s\n' "${google_client_id}"
  printf 'GOOGLE_CLIENT_SECRET=%s\n\n' "${google_client_secret}"
  printf 'CLOUDFLARE_API_TOKEN=%s\n' "${cloudflare_api_token}"
  printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "${cloudflare_tunnel_token}"
  printf 'CLOUDFLARED_IMAGE=%s\n\n' "${cloudflared_image}"
  printf 'GATEWAY_DOMAIN=%s\n' "${gateway_domain}"
  printf 'PUBLIC_BASE_URL=%s\n\n' "${public_base_url}"
  printf 'LAN_BIND_IP=%s\n' "${lan_bind_ip}"
  printf 'NETWORK_CIDRS=%s\n\n' "${network_cidrs}"
  printf 'NODE_BUILD_IMAGE=%s\n' "${node_build_image}"
  printf 'DENO_RUNTIME_IMAGE=%s\n' "${deno_runtime_image}"
  printf 'PLAYWRIGHT_IMAGE=%s\n' "${playwright_image}"
} >"${new_env}"
chmod 600 "${new_env}"
mv "${new_env}" "${ENV_FILE}"
trap - EXIT

echo "Migrated deploy/.env without printing secret values."
if (( needs_legacy_backup )); then
  echo "Legacy backup: ${BACKUP_FILE}"
else
  echo "Environment was already v1; no additional legacy backup was created."
fi
echo "OAuth key directory: ${key_dir}"
for required_external in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET CLOUDFLARE_API_TOKEN CLOUDFLARE_TUNNEL_TOKEN; do
  if ! usable_operator_value "$(env_value "${required_external}")"; then
    echo "Needs operator value: ${required_external}"
  fi
done
