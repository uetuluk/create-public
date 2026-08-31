#!/usr/bin/env bash
#
# Launch gate: hostile build container and hostile private renderer.
#
# The runtime pool already has its own evidence — the two-project isolation gate
# and the DOCKER-USER policy in install-egress-firewall.sh. Neither covers the
# other two networks a tenant's code executes on:
#
#   * the per-job build network, ritsdev-build-<jobid>, which is `internal` and
#     carries nothing but build-proxy. Nothing in RITSDEV-EGRESS applies to it,
#     because that chain only matches sources inside RUNTIME_NETWORK_POOL. Its
#     containment is `internal: true` plus the CONNECT policy in build-proxy.ts
#     and nothing else, so both halves have to be tested directly.
#
#   * ritsdev_render, where a full browser executes a tenant's page. The browser
#     is proxied through build-proxy with `bypass:'gateway,127.0.0.1,localhost'`,
#     so tenant page JavaScript can address gateway:3001 without traversing the
#     proxy at all. That bypass is deliberate — it is how the renderer reaches
#     the site it was asked to photograph — which makes the gateway's own refusal
#     of an uncredentialed request the only thing standing between a tenant's
#     page and another tenant's site.
#
# The probes run in throwaway containers hardened the same way a build container
# is, on a disposable network outside both BUILD_NETWORK_POOL and
# RUNTIME_NETWORK_POOL so a real job cannot collide with them. build-proxy is
# joined to that network under the alias a build container expects and is
# disconnected again in the exit trap; the trap also asserts that build-proxy
# ends attached to exactly the networks it started on.
#
# Nothing here restarts, stops, rebuilds, or reconfigures a service, and no
# probe carries a credential — a probe that has to be let in proves nothing.
#
# Usage:
#   deploy/scripts/gate-hostile-egress.sh
#
# Environment overrides: GATE_NETWORK, GATE_SUBNET, GATE_BRIDGE, PROBE_IMAGE,
# RENDER_NETWORK, BUILD_PROXY_CONTAINER, GATEWAY_DOMAIN, HOST_LAN_ADDRESS,
# GATE_VICTIM_HOST, RUNTIME_POOL_PROBE.

set -euo pipefail

GATE_NETWORK="${GATE_NETWORK:-ritsdev-gate-egress}"
GATE_SUBNET="${GATE_SUBNET:-192.168.90.0/28}"
GATE_BRIDGE="${GATE_BRIDGE:-rtgate0}"
PROBE_IMAGE="${PROBE_IMAGE:-curlimages/curl:8.11.1}"
RENDER_NETWORK="${RENDER_NETWORK:-ritsdev_render}"
BUILD_PROXY_CONTAINER="${BUILD_PROXY_CONTAINER:-ritsdev-build-proxy}"
GATEWAY_DOMAIN="${GATEWAY_DOMAIN:?set GATEWAY_DOMAIN to this installation's domain}"

PASSES=0
FAILURES=0
SKIPS=0
FAILED_NAMES=()

note() { printf '%s\n' "$*"; }

record() { # status name detail
  case "$1" in
    PASS) PASSES=$((PASSES + 1)) ;;
    FAIL) FAILURES=$((FAILURES + 1)); FAILED_NAMES+=("$2 — $3") ;;
    SKIP) SKIPS=$((SKIPS + 1)) ;;
  esac
  printf '%-4s  %-52s %s\n' "$1" "$2" "$3"
}

# ---------------------------------------------------------------- preflight --

command -v docker >/dev/null || { echo "docker is not on PATH" >&2; exit 2; }
docker inspect "${BUILD_PROXY_CONTAINER}" >/dev/null 2>&1 ||
  { echo "${BUILD_PROXY_CONTAINER} is not running" >&2; exit 2; }
docker network inspect "${RENDER_NETWORK}" >/dev/null 2>&1 ||
  { echo "${RENDER_NETWORK} does not exist" >&2; exit 2; }
docker image inspect "${PROBE_IMAGE}" >/dev/null 2>&1 || {
  echo "${PROBE_IMAGE} is not present locally. Pull it first:" >&2
  echo "  docker pull ${PROBE_IMAGE}" >&2
  exit 2
}

proxy_networks() {
  docker inspect "${BUILD_PROXY_CONTAINER}" \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' |
    grep -v '^$' | sort
}

BASELINE_NETWORKS="$(proxy_networks)"

container_ip() { # container network
  docker inspect "$1" --format "{{with index .NetworkSettings.Networks \"$2\"}}{{.IPAddress}}{{end}}" 2>/dev/null || true
}

POSTGRES_IP="$(container_ip ritsdev-postgres-1 ritsdev_data_control)"
PGBOUNCER_IP="$(container_ip ritsdev-pgbouncer ritsdev_data_control)"
RUSTFS_IP="$(container_ip ritsdev-rustfs ritsdev_storage_control)"
PLATFORM_IP="$(container_ip ritsdev-platform-1 ritsdev_data_control)"
GATEWAY_IP="$(container_ip ritsdev-gateway ritsdev_data_control)"
GATEWAY_RENDER_IP="$(container_ip ritsdev-gateway "${RENDER_NETWORK}")"
HOST_LAN_ADDRESS="${HOST_LAN_ADDRESS:-$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)}"

# An address inside RUNTIME_NETWORK_POOL that belongs to the host's bridge
# rather than to any tenant container, so the routing path is exercised without
# addressing a real project.
RUNTIME_POOL_PROBE="${RUNTIME_POOL_PROBE:-$(
  docker network ls --filter name=^ritsdev-project- --format '{{.Name}}' | head -1 |
  xargs -r -I{} docker network inspect {} --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null
)}"

# The gateway refuses before it resolves the host, so this need not name a live
# project for the check to mean what it says; set GATE_VICTIM_HOST to a real
# slug if you want the stronger evidence.
GATE_VICTIM_HOST="${GATE_VICTIM_HOST:-other-tenant.${GATEWAY_DOMAIN}}"

# build-proxy resolves the CONNECT authority and checks every resolved address,
# so a public name pointing at a private one should be refused. Confirm the name
# still resolves that way through build-proxy's own resolver first: a name that
# has stopped resolving is also refused, and would pass the check for the wrong
# reason.
REBIND_HOST=""
REBIND_ADDRS=""
for candidate in localtest.me 10-0-0-1.nip.io; do
  resolved="$(docker exec "${BUILD_PROXY_CONTAINER}" node -e '
    const dns = require("node:dns/promises")
    dns.lookup(process.argv[1], {all: true})
      .then(a => console.log(a.map(x => x.address).join(",")))
      .catch(() => console.log(""))
  ' "${candidate}" 2>/dev/null || true)"
  if [[ -n "${resolved}" ]] && grep -Eq '(^|,)(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|::1)' <<<"${resolved}"; then
    REBIND_HOST="${candidate}"
    REBIND_ADDRS="${resolved}"
    break
  fi
done

# ------------------------------------------------------------------ cleanup --

cleanup() {
  local status=$?
  docker network disconnect "${GATE_NETWORK}" "${BUILD_PROXY_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${GATE_NETWORK}" >/dev/null 2>&1 || true
  local after
  after="$(proxy_networks)"
  if [[ "${after}" != "${BASELINE_NETWORKS}" ]]; then
    echo
    echo "BUILD-PROXY NETWORK MEMBERSHIP CHANGED — repair before running a build." >&2
    echo "before: $(tr '\n' ' ' <<<"${BASELINE_NETWORKS}")" >&2
    echo "after:  $(tr '\n' ' ' <<<"${after}")" >&2
    exit 1
  fi
  exit "${status}"
}
trap cleanup EXIT

# ---------------------------------------------------------- the probe itself --

# Runs inside the throwaway container. Emits one tab-separated
# "status<TAB>name<TAB>detail" line per check; this script only tallies them.
read -r -d '' PROBE_SCRIPT <<'PROBE' || true
set -u
PROXY="http://build-proxy:3128"

emit() { printf '%s\t%s\t%s\n' "$1" "$2" "$3"; }

# curl through the proxy. Prints: <curl exit> <proxy CONNECT status> <http status>
# The proxy's answer to CONNECT is %{http_connect}; %{http_code} carries it too
# when the tunnel is refused, but only %{http_connect} distinguishes "the proxy
# said 403" from "the origin said 403".
via_proxy() {
  curl -s -o /dev/null --proxy "${PROXY}" --connect-timeout 6 --max-time 20 \
    -w '%{exitcode} %{http_connect} %{http_code}' "$1" 2>/dev/null || true
  printf '\n'
}

# curl with the proxy explicitly out of the way.
# Prints: <curl exit> <seconds to TCP connect> <http status>
direct() {
  curl -s -o /dev/null --noproxy '*' --connect-timeout 5 --max-time 10 \
    -w '%{exitcode} %{time_connect} %{http_code}' "$@" 2>/dev/null || true
  printf '\n'
}

is_zero() { [ -z "$(printf %s "$1" | tr -d '0.')" ]; }

# The proxy must answer CONNECT with 403 rather than opening the tunnel.
refuses_connect() {
  _name=$1; _url=$2
  set -- $(via_proxy "${_url}")
  if [ "${2:-}" = "403" ]; then
    emit PASS "${_name}" "proxy answered CONNECT 403"
  elif [ "${2:-}" = "200" ]; then
    emit FAIL "${_name}" "PROXY OPENED THE TUNNEL: connect=200 http=${3:-} curl=${1:-}"
  else
    emit FAIL "${_name}" "expected CONNECT 403, got connect=${2:-} http=${3:-} curl=${1:-}"
  fi
}

# No TCP connection may be established at all.
unreachable() {
  _name=$1; _url=$2
  set -- $(direct "${_url}")
  if [ "${1:-}" = "6" ]; then
    emit PASS "${_name}" "name does not resolve on this network (curl 6)"
  elif [ "${1:-}" != "0" ] && is_zero "${2:-0}"; then
    emit PASS "${_name}" "no TCP connection (curl ${1:-}, connect ${2:-}s)"
  else
    emit FAIL "${_name}" "REACHED IT: curl=${1:-} connect=${2:-}s http=${3:-}"
  fi
}

# An empty address means the container it belongs to is not on this host at all;
# probing "http://:5432/" would fail for the wrong reason and read as a pass.
unreachable_addr() { # name address port [scheme]
  if [ -z "$2" ]; then
    emit SKIP "$1" "address not available on this host"
    return
  fi
  unreachable "$1" "${4:-http}://$2:$3/"
}

# ---- positive controls -----------------------------------------------------
# Every "blocked" result below is worthless unless these pass: they prove the
# probe container has a working curl, a working resolver, and a live proxy.

set -- $(direct "http://build-proxy:3128/healthz")
if [ "${1:-}" = "0" ] && [ "${3:-}" = "200" ]; then
  emit PASS "${SCOPE}01 positive control: build-proxy answers /healthz" "HTTP 200"
else
  emit FAIL "${SCOPE}01 positive control: build-proxy answers /healthz" "curl=${1:-} http=${3:-}"
fi

set -- $(via_proxy "https://registry.npmjs.org/-/ping")
if [ "${2:-}" = "200" ] && [ "${3:-}" = "200" ]; then
  emit PASS "${SCOPE}02 positive control: public HTTPS through build-proxy" "CONNECT 200, HTTP 200 from registry.npmjs.org"
else
  emit FAIL "${SCOPE}02 positive control: public HTTPS through build-proxy" "connect=${2:-} http=${3:-} curl=${1:-}"
fi

set -- $(via_proxy "https://registry.npmjs.org/left-pad")
if [ "${3:-}" = "200" ]; then
  emit PASS "${SCOPE}03 positive control: a real package fetch still works" "HTTP 200 for registry.npmjs.org/left-pad"
else
  emit FAIL "${SCOPE}03 positive control: a real package fetch still works" "connect=${2:-} http=${3:-} curl=${1:-}"
fi

# ---- the network is internal ----------------------------------------------

unreachable "${SCOPE}04 direct egress to a public address, proxy unset" "https://1.1.1.1/"
unreachable "${SCOPE}05 direct egress to a public name, proxy unset" "https://registry.npmjs.org/"
unreachable "${SCOPE}06 direct egress to public TCP/80, proxy unset" "http://1.1.1.1/"

# ---- the CONNECT policy ----------------------------------------------------

refuses_connect "${SCOPE}07 CONNECT to RFC1918 10.0.0.0/8"        "https://10.0.0.5/"
refuses_connect "${SCOPE}08 CONNECT to RFC1918 172.16.0.0/12"     "https://172.16.0.5/"
refuses_connect "${SCOPE}09 CONNECT to RFC1918 192.168.0.0/16"    "https://192.168.64.65/"
refuses_connect "${SCOPE}10 CONNECT to loopback 127.0.0.1"        "https://127.0.0.1/"
refuses_connect "${SCOPE}11 CONNECT to cloud metadata 169.254.169.254" "https://169.254.169.254/"
refuses_connect "${SCOPE}12 CONNECT to link-local 169.254.0.0/16" "https://169.254.1.1/"
refuses_connect "${SCOPE}13 CONNECT to carrier-grade NAT 100.64.0.0/10" "https://100.64.0.1/"
refuses_connect "${SCOPE}14 CONNECT to 0.0.0.0/8"                 "https://0.0.0.1/"
refuses_connect "${SCOPE}15 CONNECT to IPv6 loopback ::1"         "https://[::1]/"
refuses_connect "${SCOPE}16 CONNECT to IPv6 unique-local fc00::/7" "https://[fd00::1]/"
refuses_connect "${SCOPE}17 CONNECT to the host's LAN address"    "https://${HOST_LAN}/"

# ---- the port rule ---------------------------------------------------------

refuses_connect "${SCOPE}18 CONNECT to public TCP/22"   "https://registry.npmjs.org:22/"
refuses_connect "${SCOPE}19 CONNECT to public TCP/80"   "https://registry.npmjs.org:80/"
refuses_connect "${SCOPE}20 CONNECT to public TCP/8080" "https://registry.npmjs.org:8080/"
refuses_connect "${SCOPE}21 CONNECT to public TCP/25"   "https://registry.npmjs.org:25/"

# ---- plain HTTP is not proxied --------------------------------------------

set -- $(via_proxy "http://registry.npmjs.org/-/ping")
if [ "${3:-}" = "403" ]; then
  emit PASS "${SCOPE}22 plain HTTP through the proxy is refused" "proxy answered 403 without a tunnel"
else
  emit FAIL "${SCOPE}22 plain HTTP through the proxy is refused" "connect=${2:-} http=${3:-} curl=${1:-}"
fi

set -- $(direct "http://build-proxy:3128/")
if [ "${3:-}" = "403" ]; then
  emit PASS "${SCOPE}23 the proxy serves nothing but /healthz" "HTTP 403 on /"
else
  emit FAIL "${SCOPE}23 the proxy serves nothing but /healthz" "curl=${1:-} http=${3:-}"
fi

# ---- DNS rebinding ---------------------------------------------------------

if [ -n "${REBIND_HOST}" ]; then
  refuses_connect "${SCOPE}24 CONNECT to a public name resolving to ${REBIND_ADDRS}" "https://${REBIND_HOST}/"
else
  emit SKIP "${SCOPE}24 CONNECT to a public name resolving privately" "no rebinding name resolved through build-proxy's resolver"
fi

# ---- the control plane -----------------------------------------------------

unreachable_addr "${SCOPE}25 postgres:5432 by address"          "${POSTGRES_IP}"  5432
unreachable_addr "${SCOPE}26 pgbouncer:6432 by address"         "${PGBOUNCER_IP}" 6432
unreachable_addr "${SCOPE}27 rustfs:9000 by address"            "${RUSTFS_IP}"    9000
unreachable_addr "${SCOPE}28 platform:3000 by address"          "${PLATFORM_IP}"  3000
unreachable_addr "${SCOPE}29 platform metrics :9090 by address" "${PLATFORM_IP}"  9090
unreachable_addr "${SCOPE}30 the host's LAN address on TCP/22"  "${HOST_LAN}"     22
unreachable_addr "${SCOPE}31 the host's LAN address on TCP/443" "${HOST_LAN}"     443 https
unreachable_addr "${SCOPE}32 the host's LAN address on TCP/5432" "${HOST_LAN}"    5432
unreachable_addr "${SCOPE}33 an address inside RUNTIME_NETWORK_POOL" "${RUNTIME_POOL_PROBE}" 8787
unreachable_addr "${SCOPE}34 the Docker daemon on the default bridge" 172.17.0.1  2375

# ---- name resolution -------------------------------------------------------

# Docker's embedded resolver does not answer NXDOMAIN for an unknown service on
# an internal network; it forwards upstream and the query times out. So the
# assertion is the same one as everywhere else — no connection was made — rather
# than a particular DNS failure code.
unreachable "${SCOPE}35 postgres by name"   "http://postgres:5432/"
unreachable "${SCOPE}36 pgbouncer by name"  "http://pgbouncer:6432/"
unreachable "${SCOPE}37 rustfs by name"     "http://rustfs:9000/"
unreachable "${SCOPE}38 platform by name"   "http://platform:3000/"

# build-proxy sits on ritsdev_render and can therefore both resolve and reach
# the gateway. Only the address check stops it being used as a relay to one.
refuses_connect "${SCOPE}39 CONNECT to an internal name build-proxy can resolve" "https://gateway/"

# ---- gateway, which only the render network can reach ----------------------

if [ "${SCOPE}" = "R" ]; then
  # This one asserts reachability rather than refusal. The renderer's browser
  # bypasses the proxy for `gateway`, so if this failed the renderer would be
  # broken — and every check after it would be passing for the wrong reason.
  set -- $(direct "http://gateway:3001/healthz")
  if [ "${1:-}" = "0" ] && [ "${3:-}" = "200" ]; then
    emit PASS "R40 exposure: gateway:3001 is directly reachable from the render network" "HTTP 200 on /healthz — this is what the browser bypass grants"
  else
    emit FAIL "R40 exposure: gateway:3001 is directly reachable from the render network" "curl=${1:-} http=${3:-} (renderer would be broken)"
  fi

  body=$(curl -s --noproxy '*' --max-time 10 "http://gateway:3001/healthz" 2>/dev/null || true)
  if [ "${body}" = '{"ok":true,"service":"site-gateway"}' ]; then
    emit PASS "R41 /healthz leaks nothing beyond liveness" "body is exactly {\"ok\":true,\"service\":\"site-gateway\"}"
  else
    emit FAIL "R41 /healthz leaks nothing beyond liveness" "unexpected body: $(printf %s "${body}" | head -c 200)"
  fi

  # The status alone is not enough. The gateway has two refusal branches and
  # they mean opposite things: "Requests must pass through the site edge." is
  # the credential check at gateway.ts:75, which fires *before* the host is
  # resolved, while an unknown host yields 404 "Site or deployed version not
  # found." at :78. Asserting only 403 would let a future change that refuses
  # for some unrelated reason keep this gate green, and would make the whole
  # block pass just as well against a site that does not exist. So require the
  # exact body, and point VICTIM_HOST at a site that really is deployed.
  EDGE_REFUSAL='Requests must pass through the site edge.'
  refused() { # name curl-args...
    _name=$1; shift
    _code=$(curl -s -o /dev/null --noproxy '*' --max-time 15 -w '%{http_code}' "$@" 2>/dev/null || true)
    _body=$(curl -s --noproxy '*' --max-time 15 "$@" 2>/dev/null | head -c 120 || true)
    if [ "${_code}" = "403" ] && [ "${_body}" = "${EDGE_REFUSAL}" ]; then
      emit PASS "${_name}" "HTTP 403 — ${_body}"
    elif [ "${_code}" = "403" ]; then
      emit FAIL "${_name}" "403 but from the wrong branch: ${_body}"
    else
      emit FAIL "${_name}" "expected 403, got ${_code} — ${_body}"
    fi
  }

  refused "R42 gateway refuses an uncredentialed request" \
    "http://gateway:3001/"
  refused "R43 gateway refuses an arbitrary Host naming another site" \
    -H "Host: ${VICTIM_HOST}" "http://gateway:3001/"
  refused "R44 gateway refuses a Host naming another site's API" \
    -H "Host: ${VICTIM_HOST}" "http://gateway:3001/api/"
  refused "R45 gateway refuses a forged render token" \
    -H "x-ritsdev-render-host: ${VICTIM_HOST}" \
    -H "x-ritsdev-render-token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXAiOiJyZW5kZXIiLCJob3N0IjoiZm9yZ2VkIn0.forged" \
    "http://gateway:3001/"
  refused "R46 gateway refuses an alg=none render token" \
    -H "x-ritsdev-render-host: ${VICTIM_HOST}" \
    -H "x-ritsdev-render-token: eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ0eXAiOiJyZW5kZXIiLCJob3N0Ijoib3RoZXItdGVuYW50IiwicHJvamVjdCI6IngiLCJ2ZXJzaW9uIjoieSJ9." \
    "http://gateway:3001/"
  refused "R47 gateway refuses a render host header with no token" \
    -H "x-ritsdev-render-host: ${VICTIM_HOST}" "http://gateway:3001/"
  refused "R48 gateway refuses a forged edge token" \
    -H "x-ritsdev-edge-token: not-the-edge-secret" -H "Host: ${VICTIM_HOST}" \
    "http://gateway:3001/"
  refused "R49 gateway refuses a forged edge token with a forged client address" \
    -H "x-ritsdev-edge-token: not-the-edge-secret" -H "Host: ${VICTIM_HOST}" \
    -H "x-forwarded-for: 10.0.0.1" "http://gateway:3001/"
  refused "R50 gateway serves no metrics endpoint" \
    "http://gateway:3001/metrics"
else
  unreachable_addr "B40 gateway:3001 by address" "${GATEWAY_IP}" 3001
  unreachable_addr "B41 gateway on the render network by address" "${GATEWAY_RENDER_IP}" 3001
  unreachable "B42 gateway by name" "http://gateway:3001/"
fi
PROBE

run_probe() { # scope network
  local scope="$1" network="$2"
  docker run --rm \
    --name "rits-gate-probe-${scope}-$$-${RANDOM}" \
    --network "${network}" \
    --memory 256m --cpus 0.5 --pids-limit 64 \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=8m \
    --cap-drop ALL --security-opt no-new-privileges \
    --log-driver none \
    --env "SCOPE=${scope}" \
    --env "HOST_LAN=${HOST_LAN_ADDRESS}" \
    --env "POSTGRES_IP=${POSTGRES_IP}" \
    --env "PGBOUNCER_IP=${PGBOUNCER_IP}" \
    --env "RUSTFS_IP=${RUSTFS_IP}" \
    --env "PLATFORM_IP=${PLATFORM_IP}" \
    --env "GATEWAY_IP=${GATEWAY_IP}" \
    --env "GATEWAY_RENDER_IP=${GATEWAY_RENDER_IP}" \
    --env "RUNTIME_POOL_PROBE=${RUNTIME_POOL_PROBE}" \
    --env "REBIND_HOST=${REBIND_HOST}" \
    --env "REBIND_ADDRS=${REBIND_ADDRS}" \
    --env "VICTIM_HOST=${GATE_VICTIM_HOST}" \
    --entrypoint /bin/sh \
    "${PROBE_IMAGE}" -c "${PROBE_SCRIPT}"
}

# Process substitution rather than a pipeline: a pipeline would run the loop in
# a subshell and the tallies would be discarded when it exits.
tally() { # scope network
  while IFS=$'\t' read -r status name detail; do
    [[ -z "${status}" ]] && continue
    record "${status}" "${name}" "${detail}"
  done < <(run_probe "$1" "$2")
}

# --------------------------------------------------------------- build side --

note "Hostile egress gate for $GATEWAY_DOMAIN"
note "  probe image        ${PROBE_IMAGE}"
note "  host LAN address   ${HOST_LAN_ADDRESS}"
note "  rebinding name     ${REBIND_HOST:-none resolved} ${REBIND_ADDRS}"
note "  victim host        ${GATE_VICTIM_HOST}"
note "  build-proxy on     $(tr '\n' ' ' <<<"${BASELINE_NETWORKS}")"
note ""

# The credential refusal at gateway.ts:75 runs before resolveSite at :77, so the
# R43-R49 checks are sound even against a name that was never deployed. But
# "refused a hostname that does not exist" is a much weaker sentence than
# "refused a real tenant's live site", and the two are indistinguishable in the
# output unless this is stated. So say which one this run earned.
VICTIM_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://${GATE_VICTIM_HOST}/" 2>/dev/null || true)"
case "${VICTIM_STATUS}" in
  ''|000)
    record SKIP "00 victim host is a live site" "${GATE_VICTIM_HOST} does not answer from here; cannot tell"
    ;;
  404)
    record SKIP "00 victim host is a live site" "${GATE_VICTIM_HOST} 404s: the gateway checks below refuse a name that is not deployed. Set GATE_VICTIM_HOST to a real slug for the stronger claim."
    ;;
  *)
    record PASS "00 victim host is a live site" "${GATE_VICTIM_HOST} answers ${VICTIM_STATUS} from the LAN, so the refusals below are against a real tenant"
    ;;
esac
note ""

note "== Build network: a disposable ${GATE_SUBNET} internal network, build-proxy attached as build-proxy =="
docker network create \
  --driver bridge \
  --internal \
  --subnet "${GATE_SUBNET}" \
  --opt "com.docker.network.bridge.name=${GATE_BRIDGE}" \
  --label "ritsdev.gate=hostile-egress" \
  "${GATE_NETWORK}" >/dev/null
docker network connect --alias build-proxy "${GATE_NETWORK}" "${BUILD_PROXY_CONTAINER}"
tally B "${GATE_NETWORK}"
note ""

# -------------------------------------------------------------- render side --

note "== Render network: ${RENDER_NETWORK}, where the browser executes a tenant's page =="
tally R "${RENDER_NETWORK}"
note ""

# ------------------------------------------------------------------ summary --

note "=== SUMMARY ==="
note "${PASSES} passed, ${FAILURES} failed, ${SKIPS} skipped"
for entry in "${FAILED_NAMES[@]:-}"; do
  [[ -n "${entry}" ]] && note "  FAILED: ${entry}"
done

if (( FAILURES > 0 )); then
  note ""
  note "A failure here is a finding. Do not relax the check to clear it."
  exit 1
fi
note "Hostile build and private renderer gate passed."
