#!/usr/bin/env bash
# CI: an unlocked Secret Service on this session bus, then the command. A test word for a throwaway keyring.
set -eu
eval "$(printf 'ci-keyring' | gnome-keyring-daemon --unlock --components=secrets)"
export GNOME_KEYRING_CONTROL
exec "$@"
