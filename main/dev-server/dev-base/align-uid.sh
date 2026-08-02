#!/bin/sh
#
# genie-align-uid <uid> <gid>
#
# Renumber the `genie` user so that files it writes into the bind-mounted
# /workspace carry the HOST user's ownership. Runs as root, reached only through
# the one NOPASSWD sudo rule in /etc/sudoers.d/genie, and called only by
# `genie-entrypoint` — which is where the contract and the reasoning live.
#
# It renumbers and RETURNS. It never runs the workspace command, so it never
# needs to reconstruct the environment sudo stripped on the way in, and it takes
# no input from the environment at all — only these two arguments.
#
# Everything here is idempotent: a restarted container re-runs the entrypoint,
# finds genie already at the right uid, and never gets this far.
set -eu

fail() {
    echo "genie-align-uid: $*" >&2
    exit 1
}

uid="${1:-}"
gid="${2:-}"

# Re-validated rather than trusted. The caller checks the same things, but this
# is a sudo target: it has to be correct on its own terms, not because of who
# usually calls it.
case "${uid}" in '' | *[!0-9]*) fail "uid must be numeric, got '${uid}'" ;; esac
case "${gid}" in '' | *[!0-9]*) fail "gid must be numeric, got '${gid}'" ;; esac
[ "${uid}" != '0' ] || fail 'refusing to renumber genie to uid 0'
[ "${gid}" != '0' ] || fail 'refusing to renumber genie to gid 0'

current_uid="$(id -u genie)"
current_gid="$(id -g genie)"

# `-o` (non-unique) because the host uid may already belong to a Debian system
# account inside the image. Two names for one id is harmless here; refusing to
# start because uid 999 is `systemd-network` would not be.
if [ "${gid}" != "${current_gid}" ]; then
    groupmod -o -g "${gid}" genie
fi
if [ "${uid}" != "${current_uid}" ]; then
    usermod -o -u "${uid}" -g "${gid}" genie
elif [ "${gid}" != "${current_gid}" ]; then
    usermod -g "${gid}" genie
fi

# `usermod -u` re-owns the home directory itself, but `groupmod` re-owns
# nothing, and a gid-only change would otherwise leave every cache unwritable.
# Scoped to /home/genie ON PURPOSE:
#   * /workspace is the bind mount — its files already carry the host's
#     ownership, which is precisely what we just matched. Recursively chowning
#     someone's repo would be slow and destructive.
#   * the toolchains (/usr/local/go, /usr/local/rustup, /usr/local/cargo) are
#     kept out of $HOME for exactly this reason — see the Dockerfile.
chown -R "${uid}:${gid}" /home/genie

echo "genie-dev-base: aligned user genie to ${uid}:${gid} (was ${current_uid}:${current_gid})" >&2
