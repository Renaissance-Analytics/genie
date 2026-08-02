#!/bin/sh
#
# genie-dev-base PID 1.
#
# Runs as `genie` (the image's USER). Its only job is to decide whether the
# `genie` user needs RENUMBERING to match the host, and to get out of the way if
# it does not. Whatever it is handed is exec'd verbatim, never interpreted —
# this is not a shell wrapper, and the argv it receives comes from Genie's
# `dev-server/argv.ts`, which never produces a shell string.
#
# The contract, in full:
#
#   HOST_UID   the numeric uid /workspace's files are owned by on the host
#   HOST_GID   its gid; defaults to HOST_UID when unset
#
# Both unset — the common case, and the ONLY case on macOS and Windows, where
# Docker Desktop's VM translates ownership and there is nothing to match — means
# run as the built-in genie (1000) and touch nothing at all.
#
# Failures here are WARNINGS, not exits. A sandbox that refuses to start because
# an env var was malformed is worse than one that starts with the default uid
# and says so in `docker logs`.
set -eu

warn() {
    echo "genie-dev-base: $*" >&2
}

align() {
    want_uid="$1"
    want_gid="$2"

    case "${want_uid}${want_gid}" in
        '' | *[!0-9]*)
            warn "ignoring HOST_UID='${want_uid}' HOST_GID='${want_gid}' — both must be numeric."
            return 0
            ;;
    esac

    if [ "${want_uid}" = '0' ] || [ "${want_gid}" = '0' ]; then
        # Renumbering genie to 0 would make every workspace process root, which
        # is the exact thing this image exists to avoid. A host driving Genie as
        # root is a misconfiguration, not a case to support.
        warn "refusing HOST_UID/HOST_GID of 0 — the workspace must not run as root."
        return 0
    fi

    if [ "${want_uid}" = "$(id -u)" ] && [ "${want_gid}" = "$(id -g)" ]; then
        return 0
    fi

    # The helper RENUMBERS AND RETURNS; it does not run the command. That split
    # is deliberate. `usermod` invalidates the passwd entry for the uid this
    # very process is running under, and sudo refuses to run for a uid it cannot
    # name — so there is exactly one sudo call available, and spending it on the
    # renumber is what matters.
    if ! sudo -n /usr/local/sbin/genie-align-uid "${want_uid}" "${want_gid}"; then
        warn "could not align the container user to ${want_uid}:${want_gid}."
        warn "files written to /workspace will be owned by $(id -u):$(id -g) on the host."
    fi
}

if [ -n "${HOST_UID:-}" ]; then
    align "${HOST_UID}" "${HOST_GID:-${HOST_UID}}"
fi

# This process keeps the uid it started with — renumbering a running process is
# not something Linux offers, and the alternative (re-exec'ing through sudo)
# would hand the workspace command sudo's sanitised environment instead of the
# container's. It costs nothing: PID 1 here is a hold command that touches no
# files, and every process that DOES touch files arrives later through
# `docker exec`, which resolves the image's `USER genie` against the container's
# now-rewritten /etc/passwd and therefore lands on the new uid.
exec "$@"
