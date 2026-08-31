#!/usr/bin/env bash
#
# Installs the nightly backup as a systemd timer, mirroring how
# install-egress-firewall.sh installs its unit.
#
# A timer rather than a platform job on purpose: a backup must keep running
# when the platform is the thing that has broken, and the job queue it would
# otherwise live in is inside the database being dumped.
set -euo pipefail

ROOT="${RITSDEV_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
UNIT_NAME="ritsdev-backup.service"
TIMER_NAME="ritsdev-backup.timer"
INSTALLED_SCRIPT="/usr/local/sbin/ritsdev-backup"
RUN_AS="${BACKUP_RUN_AS:-$(stat -c %U "${ROOT}/deploy/.env")}"
ON_CALENDAR="${BACKUP_ON_CALENDAR:-*-*-* 03:20:00}"

if [[ "${1:-}" == "--remove" ]]; then
  if (( EUID != 0 )); then exec sudo -n "$0" --remove; fi
  systemctl disable --now "${TIMER_NAME}" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${TIMER_NAME}" "/etc/systemd/system/${UNIT_NAME}" "${INSTALLED_SCRIPT}"
  systemctl daemon-reload
  echo "Removed the platform backup timer."
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--remove]" >&2
  exit 2
fi

if (( EUID != 0 )); then
  exec sudo -n "$0" "$@"
fi

# Owned by root so the account that runs it cannot rewrite what runs with
# access to the Docker socket, but group-owned by that account so it can
# actually execute it. Mode 0750 alone leaves this root:root, which the
# non-root User= below cannot exec at all — the unit then fails 203/EXEC every
# night while the timer goes on reporting itself healthy.
RUN_AS_GROUP="$(id -gn "${RUN_AS}")"
install -m 0750 -o root -g "${RUN_AS_GROUP}" "${ROOT}/deploy/scripts/backup.sh" "${INSTALLED_SCRIPT}"

# Runs as the deployment account, not root: it needs the Docker socket and the
# release tree, both of which that account already has, and nothing more.
cat >"/etc/systemd/system/${UNIT_NAME}" <<UNIT
[Unit]
Description=Platform off-host backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=${RUN_AS}
Environment=RITSDEV_ROOT=${ROOT}
ExecStart=${INSTALLED_SCRIPT}
# A backup that hangs must not block the next one indefinitely.
TimeoutStartSec=3600
Nice=10
IOSchedulingClass=idle
UNIT

cat >"/etc/systemd/system/${TIMER_NAME}" <<TIMER
[Unit]
Description=Nightly platform backup

[Timer]
OnCalendar=${ON_CALENDAR}
# Spread the start so a fleet does not hit the destination at once, and catch
# up after the host has been off.
RandomizedDelaySec=900
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now "${TIMER_NAME}"

# `enable --now` starts the *timer*, which succeeds whether or not the service
# it triggers can run at all. Check the one thing that silently broke here: that
# the account in User= can really execute the installed script. Without this the
# first evidence of a failure is backup_age going critical days later.
if ! sudo -u "${RUN_AS}" test -x "${INSTALLED_SCRIPT}"; then
  echo "FAILED: ${RUN_AS} cannot execute ${INSTALLED_SCRIPT}; the timer would fail 203/EXEC nightly." >&2
  ls -l "${INSTALLED_SCRIPT}" >&2
  exit 1
fi

echo "Installed ${TIMER_NAME}, running as ${RUN_AS} at: ${ON_CALENDAR}"
systemctl list-timers "${TIMER_NAME}" --no-pager | head -3
