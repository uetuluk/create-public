#!/usr/bin/env bash
#
# P1 launch gate: off-network wildcard access fails, public root MCP stays up.
#
# The design under test:
#
#   - The root domain only is published to the internet by Cloudflare
#     Tunnel, which connects straight to platform:3000 and never traverses Caddy.
#   - The wildcard beneath it (tenant sites) is served by Caddy, which publishes its
#     ports only on LAN_BIND_IP, and whose public DNS record is a private address.
#   - So from off-network the wildcard must be unreachable, while the root's
#     /healthz and /mcp must still answer.
#
# The whole difficulty of this gate is the vantage point. The workstation and the
# host are both on the trusted network, where the wildcard resolves to the LAN
# address and is answered by Caddy directly, so a local curl proves nothing
# about the public internet. Two traps found the hard way, both worth keeping:
#
#   1. An agent's own web-fetch tool is NOT an off-network vantage. It looks
#      like one, but such a fetch of a wildcard host was observed arriving in
#      Caddy's site-access.log from an address on the trusted network. The HTTP
#      404 it reported was Caddy's real on-LAN 404 for an unknown application,
#      not a connection failure. Do not build this gate on it.
#   2. An unknown wildcard host returns 404 on-LAN as well, so "404" is not
#      evidence of anything. Probe a hostname that DOES serve content on-LAN, and
#      require the off-network result to be a transport failure, not a status.
#
# So the off-network HTTP evidence here comes from check-host.net, which performs
# the request from its own nodes in several countries and reports each node's
# transport-level result. The DNS evidence comes from public DoH resolvers, whose
# answers are what the public internet sees regardless of where this runs.
#
# Named checks, PASS/FAIL/SKIP, non-zero exit if anything FAILs. A SKIP does not
# fail the run — the third-party vantage being down must not be reported as the
# platform being broken — but the closing summary says exactly which claims lost
# their evidence, because a gate that quietly downgrades is worse than no gate.
#
# Usage:
#   ./deploy/scripts/gate-offnetwork-wildcard.sh
#   RITSDEV_TENANT_HOST=todo.sites.example.org ./deploy/scripts/gate-offnetwork-wildcard.sh
#
# See docs/operations.md for what this does not establish and the two-minute
# manual hotspot procedure that closes the remaining gap.
set -uo pipefail

DOMAIN="${RITSDEV_DOMAIN:?set RITSDEV_DOMAIN to this installation's domain}"
ROOT_URL="${RITSDEV_URL:-https://${DOMAIN}}"
# A hostname that really serves something on-LAN, so an off-network failure is a
# contrast rather than a tautology. Any deployed project works.
TENANT_HOST="${RITSDEV_TENANT_HOST:-todo.${DOMAIN}}"
# A label that has certainly never been deployed, for the DNS wildcard checks.
PROBE_LABEL="offnet-gate-$(date -u +%Y%m%d%H%M%S)"
PROBE_HOST="${PROBE_LABEL}.${DOMAIN}"
REPO_ROOT="${RITSDEV_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
COMPOSE_FILE="${REPO_ROOT}/deploy/compose.yaml"
CADDYFILE="${REPO_ROOT}/deploy/Caddyfile"
CURL=(curl --silent --show-error --max-time 25)

PASSED=0
FAILED=0
SKIPPED=0
SKIPPED_NAMES=()

pass() { printf 'PASS  %-32s %s\n' "$1" "${2-}"; PASSED=$((PASSED + 1)); }
fail() { printf 'FAIL  %-32s %s\n' "$1" "${2-}"; FAILED=$((FAILED + 1)); }
skip() {
  printf 'SKIP  %-32s %s\n' "$1" "${2-}"
  SKIPPED=$((SKIPPED + 1))
  SKIPPED_NAMES+=("$1")
}
note() { printf '      %s\n' "$1"; }

have_python() { command -v python3 >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# DNS, from public resolvers.
#
# These answer with what the public internet sees, so they are independent of
# where this script runs. That independence is the point: it is the one class of
# evidence that survives being gathered from inside the trusted network.
# ---------------------------------------------------------------------------

doh_answer() {
  # doh_answer <resolver> <name> <type>
  #   stdout: "status <rcode>" on the first line, then one rdata line per
  #           matching answer.
  #   return: non-zero if the resolver could not be reached, or answered with
  #           something that is not a DNS response.
  #
  # The return code carries the whole point. An earlier version printed rdata
  # and nothing else, so a resolver that could not be reached produced exactly
  # the same empty output as a name that does not exist — and the wildcard
  # checks read that emptiness as "nothing for the internet to route to" and
  # PASSED. Breaking DNS to the two resolvers turned this gate's strongest
  # claim green. A resolver we could not ask must never look like an answer.
  local resolver="$1" name="$2" rrtype="$3" url
  case "${resolver}" in
    cloudflare) url="https://cloudflare-dns.com/dns-query?name=${name}&type=${rrtype}" ;;
    google) url="https://dns.google/resolve?name=${name}&type=${rrtype}" ;;
    *) return 1 ;;
  esac
  "${CURL[@]}" -H 'accept: application/dns-json' "${url}" 2>/dev/null |
    python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(d, dict) or "Status" not in d:
    sys.exit(1)
want = int(sys.argv[1])
print("status %d" % d["Status"])
for a in d.get("Answer", []):
    if a.get("type") == want:
        print(a.get("data", "").rstrip("."))
' "$(case "${rrtype}" in A) echo 1 ;; AAAA) echo 28 ;; *) echo 5 ;; esac)"
}

# 0 is NOERROR and 3 is NXDOMAIN. Both are real answers: the name either has no
# address of this type, or does not exist. Anything else (SERVFAIL, REFUSED) is
# the resolver declining to answer, which is not evidence about the name.
doh_rcode_is_answer() { [[ "$1" == "0" || "$1" == "3" ]]; }

is_private_v4() {
  # RFC1918, CGNAT, loopback and link-local: none of them routable across the
  # public internet, which is the property this gate actually depends on.
  case "$1" in
    10.*|127.*|169.254.*|192.168.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[0-1][0-9].*|100.12[0-7].*) return 0 ;;
  esac
  return 1
}

check_dns_wildcard_private() {
  local resolver="$1" name="check_dns_wildcard_${1}" raw rcode answers ip bad=0 count=0
  if ! have_python; then
    skip "${name}" "python3 not available to parse the DoH response"
    return
  fi
  if ! raw="$(doh_answer "${resolver}" "${PROBE_HOST}" A)"; then
    skip "${name}" "could not reach the ${resolver} resolver; this says nothing either way"
    return
  fi
  rcode="${raw%%$'\n'*}"; rcode="${rcode#status }"
  answers="$(printf '%s' "${raw}" | tail -n +2)"
  if [[ -z "${answers}" ]]; then
    if doh_rcode_is_answer "${rcode}"; then
      # NXDOMAIN or NODATA is a pass: nothing off-network can reach a name that
      # does not resolve. But only once we know the resolver actually answered.
      pass "${name}" "${PROBE_HOST} has no public A record (rcode ${rcode})"
    else
      skip "${name}" "${resolver} declined to answer (rcode ${rcode}); no evidence"
    fi
    return
  fi
  while read -r ip; do
    [[ -z "${ip}" ]] && continue
    count=$((count + 1))
    is_private_v4 "${ip}" || { bad=1; note "public address in wildcard answer: ${ip}"; }
  done <<<"${answers}"
  if [[ ${bad} -eq 0 && ${count} -gt 0 ]]; then
    pass "${name}" "$(echo "${answers}" | tr '\n' ' ')(private/unroutable)"
  else
    fail "${name}" "wildcard resolves publicly to a routable address"
  fi
}

check_dns_wildcard_no_aaaa() {
  # The whole design rests on the wildcard's public address being unroutable,
  # and it is unroutable because it is RFC1918 — a property IPv6 global unicast
  # has no equivalent of. So a single AAAA record added to the wildcard would
  # make every tenant site reachable from the internet while every IPv4 check
  # in this gate stayed green. Assert its absence rather than assume it.
  local name="check_dns_wildcard_no_aaaa" raw rcode answers
  if ! have_python; then
    skip "${name}" "python3 not available to parse the DoH response"
    return
  fi
  if ! raw="$(doh_answer cloudflare "${PROBE_HOST}" AAAA)"; then
    skip "${name}" "could not reach the resolver; absence of an AAAA is unproven"
    return
  fi
  rcode="${raw%%$'\n'*}"; rcode="${rcode#status }"
  answers="$(printf '%s' "${raw}" | tail -n +2)"
  if [[ -n "${answers}" ]]; then
    fail "${name}" "the wildcard publishes AAAA $(echo "${answers}" | tr '\n' ' ')— globally routable"
    return
  fi
  if doh_rcode_is_answer "${rcode}"; then
    pass "${name}" "no AAAA on the wildcard (rcode ${rcode})"
  else
    skip "${name}" "resolver declined to answer (rcode ${rcode}); no evidence"
  fi
}

check_dns_wildcard_no_tunnel_cname() {
  local name="check_dns_no_tunnel_cname" answers
  if ! have_python; then
    skip "${name}" "python3 not available to parse the DoH response"
    return
  fi
  if ! answers="$(doh_answer cloudflare "${TENANT_HOST}" CNAME)"; then
    # Absence of a CNAME is the entire claim here, so an unanswered query would
    # otherwise read as the strongest possible evidence.
    skip "${name}" "could not reach the resolver; absence of a CNAME is unproven"
    return
  fi
  if grep -qi 'cfargotunnel\.com' <<<"${answers}"; then
    fail "${name}" "${TENANT_HOST} is CNAMEd into a Cloudflare Tunnel"
    return
  fi
  # A Cloudflare Tunnel public hostname requires a proxied CNAME to
  # <tunnel-id>.cfargotunnel.com. Its absence is the strongest statement about
  # the tunnel's ingress that can be made without the Cloudflare dashboard.
  pass "${name}" "no *.cfargotunnel.com CNAME on ${TENANT_HOST}"
}

check_dns_root_is_edge() {
  local name="check_dns_root_cloudflare_edge" answers ip private=0 count=0
  if ! have_python; then
    skip "${name}" "python3 not available to parse the DoH response"
    return
  fi
  if ! answers="$(doh_answer cloudflare "${DOMAIN}" A)"; then
    skip "${name}" "could not reach the resolver"
    return
  fi
  answers="$(printf '%s' "${answers}" | tail -n +2)"
  if [[ -z "${answers}" ]]; then
    fail "${name}" "${DOMAIN} has no public A record"
    return
  fi
  while read -r ip; do
    [[ -z "${ip}" ]] && continue
    count=$((count + 1))
    is_private_v4 "${ip}" && private=1
  done <<<"${answers}"
  if [[ ${private} -eq 1 ]]; then
    fail "${name}" "root resolves to a private address; the tunnel path is gone"
    return
  fi
  # That these are Cloudflare's anycast addresses is asserted by the response
  # headers in check_public_healthz, not by hard-coding an address range here.
  pass "${name}" "$(echo "${answers}" | tr '\n' ' ')(public)"
}

# ---------------------------------------------------------------------------
# The public root, over the real Cloudflare path.
#
# These run from wherever this script runs, but the traffic still egresses to
# Cloudflare's anycast addresses and returns through the tunnel — the cf-ray
# header is the proof that the response came back through the edge and not from
# some local shortcut. Network position does not change what they establish.
# ---------------------------------------------------------------------------

check_public_healthz() {
  local name="check_public_healthz" out status body
  out="$("${CURL[@]}" -D - -o /tmp/ritsdev-gate-healthz.$$ -w '%{http_code}' "${ROOT_URL}/healthz" 2>/dev/null)"
  status="${out##*$'\n'}"
  body="$(cat /tmp/ritsdev-gate-healthz.$$ 2>/dev/null)"
  rm -f /tmp/ritsdev-gate-healthz.$$
  if [[ "${status}" != "200" ]]; then
    fail "${name}" "expected 200, got ${status:-no response}"
    return
  fi
  if ! grep -q '"ok":true' <<<"${body}"; then
    fail "${name}" "200 but body is not the control plane's health response"
    return
  fi
  if ! grep -qi '^cf-ray:' <<<"${out}"; then
    fail "${name}" "200 without a cf-ray header; this did not come through the edge"
    return
  fi
  pass "${name}" "200 through the Cloudflare edge"
}

check_public_mcp_get() {
  # A GET is expected to be 405: there is no SSE GET stream. Recorded explicitly
  # because a GET probe once misled a session into reading 405 as a regression.
  local name="check_public_mcp_get_405" status
  status="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${ROOT_URL}/mcp" 2>/dev/null)"
  if [[ "${status}" == "405" ]]; then
    pass "${name}" "405, as expected for a GET with no SSE stream"
  else
    fail "${name}" "expected 405, got ${status:-no response}"
  fi
}

check_public_mcp_post() {
  # The real assertion: MCP is publicly reachable AND refuses unauthenticated
  # callers with a challenge a client can act on.
  local name="check_public_mcp_post_401" out status
  out="$("${CURL[@]}" -D - -o /dev/null -w '%{http_code}' \
    -X POST \
    -H 'Content-Type: application/json' \
    -H 'MCP-Protocol-Version: 2025-06-18' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"offnetwork-gate","version":"1"}}}' \
    "${ROOT_URL}/mcp" 2>/dev/null)"
  status="${out##*$'\n'}"
  if [[ "${status}" != "401" ]]; then
    fail "${name}" "expected 401, got ${status:-no response}"
    return
  fi
  if ! grep -qi '^www-authenticate: *bearer' <<<"${out}"; then
    fail "${name}" "401 without a WWW-Authenticate: Bearer challenge"
    return
  fi
  if ! grep -qi '^cf-ray:' <<<"${out}"; then
    fail "${name}" "401 without a cf-ray header; this did not come through the edge"
    return
  fi
  pass "${name}" "401 with a Bearer challenge, through the Cloudflare edge"
}

# ---------------------------------------------------------------------------
# Genuinely off-network HTTP, from third-party nodes.
#
# check-host.net runs the request from its own machines in several countries and
# reports each node's result, including transport failures. That is the vantage
# this gate could not otherwise obtain from inside the trusted network.
# ---------------------------------------------------------------------------

checkhost_run() {
  # checkhost_run <url> <nodes> -> lines of "<node>|<status_or_empty>|<message>"
  local url="$1" nodes="${2:-6}" encoded submitted request_id attempt raw
  encoded="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "${url}")"
  submitted="$("${CURL[@]}" -H 'Accept: application/json' \
    "https://check-host.net/check-http?host=${encoded}&max_nodes=${nodes}" 2>/dev/null)"
  request_id="$(python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("request_id") or "")
except Exception:
    pass
' <<<"${submitted}")"
  [[ -z "${request_id}" ]] && return 1

  for attempt in 1 2 3 4 5 6 7 8; do
    sleep 5
    raw="$("${CURL[@]}" -H 'Accept: application/json' \
      "https://check-host.net/check-result/${request_id}" 2>/dev/null)"
    if python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if d and all(v is not None for v in d.values()) else 1)
' <<<"${raw}"; then
      python3 -c '
import json, sys
d = json.load(sys.stdin)
for node, res in sorted(d.items()):
    entry = (res or [None])[0] or []
    status = entry[3] if len(entry) > 3 and entry[3] else ""
    message = entry[2] if len(entry) > 2 and entry[2] else ""
    print("%s|%s|%s" % (node, status, message))
' <<<"${raw}"
      return 0
    fi
  done
  return 1
}

check_offnet_root() {
  local name="check_offnet_root_reachable" results ok=0 total=0 line status
  if ! have_python; then
    skip "${name}" "python3 not available"
    return
  fi
  if ! results="$(checkhost_run "${ROOT_URL}/healthz" 6)"; then
    skip "${name}" "check-host.net did not return a result; see the manual procedure"
    return
  fi
  while IFS='|' read -r line status _; do
    [[ -z "${line}" ]] && continue
    total=$((total + 1))
    [[ "${status}" == "200" ]] && ok=$((ok + 1))
  done <<<"${results}"
  if [[ ${ok} -ge 3 ]]; then
    pass "${name}" "${ok}/${total} third-party nodes got HTTP 200"
  else
    fail "${name}" "only ${ok}/${total} third-party nodes could reach ${ROOT_URL}/healthz"
    printf '%s\n' "${results}" | while IFS='|' read -r n s m; do note "${n} ${s} ${m}"; done
  fi
}

check_offnet_mcp() {
  local name="check_offnet_mcp_reachable" results ok=0 total=0 line status
  if ! have_python; then
    skip "${name}" "python3 not available"
    return
  fi
  if ! results="$(checkhost_run "${ROOT_URL}/mcp" 4)"; then
    skip "${name}" "check-host.net did not return a result; see the manual procedure"
    return
  fi
  # These nodes can only issue a GET, so 405 is the expected answer and is the
  # thing being asserted: the app itself replied, from off-network. The 401 for
  # an unauthenticated POST is asserted separately, over the same edge path.
  while IFS='|' read -r line status _; do
    [[ -z "${line}" ]] && continue
    total=$((total + 1))
    [[ "${status}" == "405" ]] && ok=$((ok + 1))
  done <<<"${results}"
  if [[ ${ok} -ge 3 ]]; then
    pass "${name}" "${ok}/${total} third-party nodes reached /mcp (405 from the app)"
  else
    fail "${name}" "only ${ok}/${total} third-party nodes reached ${ROOT_URL}/mcp"
    printf '%s\n' "${results}" | while IFS='|' read -r n s m; do note "${n} ${s} ${m}"; done
  fi
}

check_offnet_wildcard() {
  local name="check_offnet_wildcard_unreachable" results served=0 total=0 line status message
  if ! have_python; then
    skip "${name}" "python3 not available"
    return
  fi
  if ! results="$(checkhost_run "https://${TENANT_HOST}/" 6)"; then
    skip "${name}" "check-host.net did not return a result; see the manual procedure"
    return
  fi
  while IFS='|' read -r line status message; do
    [[ -z "${line}" ]] && continue
    total=$((total + 1))
    if [[ -n "${status}" ]]; then
      served=$((served + 1))
      note "${line} served HTTP ${status} (${message})"
    fi
  done <<<"${results}"
  if [[ ${total} -lt 3 ]]; then
    skip "${name}" "only ${total} nodes reported; too few to conclude"
    return
  fi
  if [[ ${served} -eq 0 ]]; then
    pass "${name}" "0/${total} third-party nodes could reach ${TENANT_HOST}"
    printf '%s\n' "${results}" | while IFS='|' read -r n s m; do note "${n} ${m}"; done
  else
    fail "${name}" "${served}/${total} third-party nodes were served ${TENANT_HOST}"
  fi
}

check_lan_tenant_control() {
  # Informational positive control, never a failure. If the tenant host answers
  # from here, the off-network failure above is a contrast rather than a
  # tautology: the same name serves something on one side and nothing on the
  # other. Run from off-network, this correctly finds nothing and stays silent.
  local name="check_lan_tenant_control" status
  status="$(curl --silent --show-error --max-time 8 -o /dev/null -w '%{http_code}' \
    "https://${TENANT_HOST}/" 2>/dev/null)"
  case "${status}" in
    ''|000)
      skip "${name}" "${TENANT_HOST} does not answer from here either; no positive control"
      ;;
    404)
      # Caddy answers an unknown application with 404, which is precisely the
      # non-evidence this gate's header warns about. Accepting it here would
      # have called an undeployed name "really served on-LAN".
      skip "${name}" "${TENANT_HOST} 404s on-LAN: not a deployed project, so the contrast is weaker. Set RITSDEV_TENANT_HOST to a live one."
      ;;
    *)
      pass "${name}" "${TENANT_HOST} answers ${status} from here, so it is really served on-LAN"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Structure. Corroboration, not proof: it says what the configuration intends,
# and the checks above say what the internet actually observes.
# ---------------------------------------------------------------------------

check_caddy_lan_only() {
  local name="check_caddy_binds_lan_only" ports bad=0 line
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    skip "${name}" "no ${COMPOSE_FILE}"
    return
  fi
  ports="$(awk '
    /^  caddy:/ { in_caddy = 1; next }
    /^  [a-z0-9_-]+:/ { in_caddy = 0 }
    in_caddy && /^    ports:/ { in_ports = 1; next }
    in_caddy && in_ports && /^      - / { print; next }
    in_ports { in_ports = 0 }
  ' "${COMPOSE_FILE}")"
  if [[ -z "${ports}" ]]; then
    fail "${name}" "could not find the caddy service's published ports"
    return
  fi
  while read -r line; do
    [[ -z "${line}" ]] && continue
    grep -q '\${LAN_BIND_IP' <<<"${line}" || { bad=1; note "unbound published port: ${line}"; }
  done <<<"${ports}"
  if [[ ${bad} -eq 0 ]]; then
    pass "${name}" "$(grep -c . <<<"${ports}") published ports, all on \${LAN_BIND_IP}"
  else
    fail "${name}" "caddy publishes a port on every interface"
  fi
}

check_no_wildcard_ingress() {
  local name="check_no_wildcard_tunnel_ingress" hits
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    skip "${name}" "no ${COMPOSE_FILE}"
    return
  fi
  # cloudflared here is token-driven: its ingress lives in Cloudflare's own
  # configuration, which this gate cannot read — never `docker inspect` that
  # container, the tunnel token is in its command line. What can be asserted
  # locally is that nothing in this repository asks for a wildcard ingress, and
  # that the caution is still written next to the service. The DNS check above
  # is the part that actually observes Cloudflare's answer.
  # Comments are stripped first: the caution below is itself the word "ingress",
  # and matching it would make the gate fail on its own documentation.
  hits="$(grep -n -v '^ *#' "${COMPOSE_FILE}" |
    grep -i 'ingress\|cfargotunnel\|hostname: *"\?\*\.' || true)"
  if [[ -n "${hits}" ]]; then
    fail "${name}" "compose declares tunnel ingress configuration"
    printf '%s\n' "${hits}" | while read -r line; do note "${line}"; done
    return
  fi
  if ! grep -q 'Never add a wildcard ingress' "${COMPOSE_FILE}"; then
    fail "${name}" "the root-only tunnel caution has been removed from compose.yaml"
    return
  fi
  pass "${name}" "no wildcard ingress declared; root-only caution intact"
}

check_caddyfile_names() {
  local name="check_caddyfile_serves_wildcard"
  if [[ ! -f "${CADDYFILE}" ]]; then
    skip "${name}" "no ${CADDYFILE}"
    return
  fi
  if grep -q "^\*\.${DOMAIN} {" "${CADDYFILE}" && grep -q "^${DOMAIN} {" "${CADDYFILE}"; then
    pass "${name}" "Caddy answers both names; only its LAN-bound ports carry them"
  else
    fail "${name}" "Caddyfile no longer serves the expected names"
  fi
}

# ---------------------------------------------------------------------------

echo "Off-network wildcard gate for ${DOMAIN}"
echo "  tenant probe: ${TENANT_HOST}"
echo "  dns probe:    ${PROBE_HOST}"
echo

echo "-- public DNS, from resolvers outside this network"
check_dns_wildcard_private cloudflare
check_dns_wildcard_private google
check_dns_wildcard_no_aaaa
check_dns_wildcard_no_tunnel_cname
check_dns_root_is_edge
echo

echo "-- the public root, over the Cloudflare edge"
check_public_healthz
check_public_mcp_get
check_public_mcp_post
echo

echo "-- off-network HTTP, from third-party nodes"
check_lan_tenant_control
check_offnet_root
check_offnet_mcp
check_offnet_wildcard
echo

echo "-- structure"
check_caddy_lan_only
check_no_wildcard_ingress
check_caddyfile_names
echo

echo "${PASSED} passed, ${FAILED} failed, ${SKIPPED} skipped."
if [[ ${SKIPPED} -gt 0 ]]; then
  echo
  echo "Skipped checks left these claims without evidence this run:"
  for n in "${SKIPPED_NAMES[@]}"; do echo "  - ${n}"; done
  echo "Re-run, or perform the manual off-network step in docs/operations.md."
fi
if [[ ${FAILED} -gt 0 ]]; then
  exit 1
fi
echo
echo "Off-network wildcard gate passed."
echo "This gate observes DNS and third-party HTTP. It does not read Cloudflare's"
echo "tunnel ingress — the dashboard is the authority for that and is not"
echo "reachable from here. See docs/operations.md."
