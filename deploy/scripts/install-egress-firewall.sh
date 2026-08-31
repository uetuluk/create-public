#!/usr/bin/env bash
set -euo pipefail

ROOT="${RITSDEV_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ENV_FILE="${ROOT}/deploy/.env"
CHAIN="RITSDEV-EGRESS"
IPTABLES="${IPTABLES:-iptables}"
UNIT_NAME="ritsdev-egress-firewall.service"
INSTALLED_SCRIPT="/usr/local/sbin/ritsdev-egress-firewall"
APPLY_ONLY=0

if [[ "${1:-}" == "--apply-only" ]]; then
  APPLY_ONLY=1
elif [[ -n "${1:-}" && "${1:-}" != "--remove" ]]; then
  echo "Usage: $0 [--apply-only|--remove]" >&2
  exit 2
fi

if [[ "${1:-}" == "--remove" ]]; then
  if (( EUID != 0 )); then
    exec sudo -n "$0" --remove
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable "${UNIT_NAME}" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${UNIT_NAME}"
    rm -f "${INSTALLED_SCRIPT}"
    systemctl daemon-reload
  fi
  while "${IPTABLES}" -w 10 -C DOCKER-USER -j "${CHAIN}" 2>/dev/null; do
    "${IPTABLES}" -w 10 -D DOCKER-USER -j "${CHAIN}"
  done
  "${IPTABLES}" -w 10 -F "${CHAIN}" 2>/dev/null || true
  "${IPTABLES}" -w 10 -X "${CHAIN}" 2>/dev/null || true
  echo "Removed the platform runtime egress policy."
  exit 0
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing deploy/.env." >&2
  exit 1
fi

if (( EUID != 0 )); then
  exec sudo -n "$0"
fi

cd "${ROOT}/deploy"
COMPOSE_ENV="$(docker compose --env-file "${ENV_FILE}" config --environment)"
RUNTIME_POOL="$(
  awk -F= '$1 == "RUNTIME_NETWORK_POOL" {sub(/^[^=]*=/, ""); print; exit}' <<<"${COMPOSE_ENV}"
)"
RUNTIME_POOL="${RUNTIME_POOL:-192.168.68.0/22}"

if ! [[ "${RUNTIME_POOL}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
  echo "RUNTIME_NETWORK_POOL must be an IPv4 CIDR, got: ${RUNTIME_POOL}" >&2
  exit 1
fi

if ! "${IPTABLES}" -w 10 -S DOCKER-USER >/dev/null 2>&1; then
  echo "Docker's DOCKER-USER chain is unavailable; start Docker first." >&2
  exit 1
fi

"${IPTABLES}" -w 10 -N "${CHAIN}" 2>/dev/null || true
"${IPTABLES}" -w 10 -F "${CHAIN}"

# Replies for permitted connections must return before the destination checks.
"${IPTABLES}" -w 10 -A "${CHAIN}" \
  -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

# Tenant runtimes may reach only their managed data planes within the reserved
# runtime pool. PostgreSQL and RustFS enforce per-project credentials/policies.
"${IPTABLES}" -w 10 -A "${CHAIN}" -s "${RUNTIME_POOL}" -d "${RUNTIME_POOL}" \
  -p tcp -m multiport --dports 6432,9000 -j RETURN

# Public HTTPS is the only general runtime egress. Private, link-local,
# metadata, SMTP, Docker, and every other destination/port fall through to the
# final drop. DNS uses Docker's embedded resolver and does not traverse here.
for denied_destination in \
  0.0.0.0/8 \
  10.0.0.0/8 \
  100.64.0.0/10 \
  127.0.0.0/8 \
  169.254.0.0/16 \
  172.16.0.0/12 \
  192.0.0.0/24 \
  192.168.0.0/16 \
  198.18.0.0/15 \
  224.0.0.0/4 \
  240.0.0.0/4
do
  "${IPTABLES}" -w 10 -A "${CHAIN}" -s "${RUNTIME_POOL}" \
    -d "${denied_destination}" -j DROP
done
"${IPTABLES}" -w 10 -A "${CHAIN}" -s "${RUNTIME_POOL}" \
  -p tcp --dport 443 -m addrtype ! --dst-type LOCAL -j RETURN
"${IPTABLES}" -w 10 -A "${CHAIN}" -s "${RUNTIME_POOL}" -j DROP
"${IPTABLES}" -w 10 -A "${CHAIN}" -j RETURN

while "${IPTABLES}" -w 10 -C DOCKER-USER -j "${CHAIN}" 2>/dev/null; do
  "${IPTABLES}" -w 10 -D DOCKER-USER -j "${CHAIN}"
done
"${IPTABLES}" -w 10 -I DOCKER-USER 1 -j "${CHAIN}"

if (( APPLY_ONLY == 0 )) && command -v systemctl >/dev/null 2>&1; then
  if [[ "${ROOT}" =~ [[:space:]] ]]; then
    echo "Cannot persist firewall service for a path containing whitespace: ${ROOT}" >&2
    exit 1
  fi
  install -m 0755 "$(realpath "$0")" "${INSTALLED_SCRIPT}"
  command -v restorecon >/dev/null 2>&1 && restorecon "${INSTALLED_SCRIPT}" || true
  UNIT_TMP="$(mktemp)"
  trap 'rm -f "${UNIT_TMP}"' EXIT
  printf '%s\n' \
    '[Unit]' \
    'Description=Platform tenant runtime egress policy' \
    'Requires=docker.service' \
    'PartOf=docker.service' \
    'After=docker.service' \
    '' \
    '[Service]' \
    'Type=oneshot' \
    "Environment=RITSDEV_ROOT=${ROOT}" \
    "ExecStart=${INSTALLED_SCRIPT} --apply-only" \
    'RemainAfterExit=yes' \
    '' \
    '[Install]' \
    'WantedBy=multi-user.target' >"${UNIT_TMP}"
  install -m 0644 "${UNIT_TMP}" "/etc/systemd/system/${UNIT_NAME}"
  systemctl daemon-reload
  systemctl enable "${UNIT_NAME}" >/dev/null
fi

echo "Installed runtime egress policy for ${RUNTIME_POOL}."
"${IPTABLES}" -w 10 -S "${CHAIN}"
