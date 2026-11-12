#!/usr/bin/env bash
# Tynn #471 / #391 M1. HUMAN-RUN ONLY on omarchy-test; allow about 20-30 minutes.
# The author must NOT execute this script, call Claude, or sign anyone in.
# Run: bash scripts/measure/claude-account-isolation.sh
# Needs Bash 4+, jq, GNU coreutils/findutils, Claude Code, and two claude.ai
# subscription accounts. Tynn arranges the VM/sign-ins, then powers it off.
#
# Official Anthropic docs checked 2026-11-12:
# https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts
#   Separate CLAUDE_CONFIG_DIR homes isolate claude.ai logins. Keyless Console
#   logins are an explicit exception, so they are outside this measurement.
# https://code.claude.com/docs/en/authentication#credential-management
#   Linux credentials: <CLAUDE_CONFIG_DIR>/.credentials.json (normally mode0600).
#   This script tests existence/type/mode ONLY: never opens, copies or hashes it.
# https://code.claude.com/docs/en/env-vars (CLAUDE_CONFIG_DIR)
#   Settings, session history and plugins share the selected config namespace.
# https://code.claude.com/docs/en/cli-reference
#   auth status: JSON, exit0 signed in / exit1 signed out; authMethod is an enum.
#   configDirectory requires v2.1.268; missing fields remain UNMEASURED.
#   auth login/logout and --continue are documented provider commands.
# https://code.claude.com/docs/en/settings
# https://code.claude.com/docs/en/plugin-marketplaces#create-a-marketplace
# https://code.claude.com/docs/en/plugins/cli-reference#plugin-install
#   A local marketplace with user-scope installation exercises provider-written
#   settings and plugin storage. The fixture has text-only skills, no hooks/code.
#
# Only --version and filtered auth status are invoked by this harness. ALL login,
# logout, plugin changes and conversations are done by the person in separate,
# UNRECORDED terminals. Never tee/script/record those terminals or paste tokens,
# login URLs/codes, account emails, credentials or provider output here.
# Only this harness's sanitized output may be saved as measurement evidence.
# Raw auth status stays in an anonymous pipe; only fixed, allowlisted fields and
# exit codes are emitted. stderr is suppressed, including parse/provider errors.
# No contents of settings, transcripts, plugins or credential stores are read.
# Filesystem checks are metadata observations, not stable internal-format claims.
# Human observations are labelled as such; skipped/unsupported checks never PASS.
# This measures namespaces under one OS user, not an OS security boundary.
# No Codex, Design authorization, account switching implementation or release.
# No auto-cleanup: homes contain provider-owned credentials needed for restart
# controls. After recording the summary, log out in both test homes, close the
# test terminals, and reset/power off the VM per the test-VM runbook.

if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
    printf 'Run this script with bash; do not source it.\n' >&2
    return 2
fi
set +x +v
set -uo pipefail
umask 077
if (( BASH_VERSINFO[0] < 4 )); then
    printf 'UNMEASURED prerequisites: Bash4 or later required\nSUMMARY UNMEASURED PASS=0 FAIL=0 UNMEASURED=1 exit=2\n'
    exit 2
fi

checks=(vm prerequisites cli-version fresh-A fresh-B config-A config-B login-A
    B-after-login-A login-A-keeps-B login-B A-after-login-B login-B-keeps-A
    distinct-accounts credentials-A credentials-B settings-A history-A plugins-A A-keeps-B-artifacts
    settings-B history-B plugins-B B-keeps-A-artifacts resume-A resume-B shared-home-gauge
    concurrent-sessions concurrent-A logout-B A-after-logout-B logout-B-keeps-A A-still-answers
    relogin-B A-after-relogin-B relogin-B-keeps-A restart-A restart-B restart-resume)
declare -A results=()
run_root=''

record() {
    local id=$1 verdict=$2 detail=$3
    [[ -z ${results[$id]+present} ]] || return 0
    results[$id]=$verdict
    printf '%s %s: %s\n' "$verdict" "$id" "$detail"
}

finish() {
    local original=$? id pass=0 fail=0 unmeasured=0 verdict rc
    trap - EXIT
    for id in "${checks[@]}"; do
        if [[ -z ${results[$id]+present} ]]; then
            record "$id" UNMEASURED 'not reached or person skipped; no result inferred'
        fi
        case ${results[$id]} in
            PASS) pass=$((pass + 1)) ;;
            FAIL) fail=$((fail + 1)) ;;
            *) unmeasured=$((unmeasured + 1)) ;;
        esac
    done
    if [[ -n $run_root ]]; then
        printf 'Test homes remain private at %s; never attach their contents. Close test sessions and reset/power off omarchy-test after recording this summary.\n' "$run_root"
    fi
    rc=0 verdict=PASS
    if (( unmeasured > 0 )); then rc=2; verdict=UNMEASURED; fi
    if (( fail > 0 )); then rc=1; verdict=FAIL; fi
    if (( original != 0 && original != 2 )); then
        rc=$original
        if (( fail == 0 )); then verdict=UNMEASURED; fi
    fi
    printf 'SUMMARY %s PASS=%s FAIL=%s UNMEASURED=%s exit=%s\n' "$verdict" "$pass" "$fail" "$unmeasured" "$rc"
    exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

answer() {
    # Fixed choices only, with echo disabled; never ask for an identity or token.
    local value
    printf '%s [yes/no/skip]: ' "$1" >/dev/tty
    IFS= read -r -s value </dev/tty || exit 2
    printf '\n' >/dev/tty
    case $value in yes) return 0 ;; no) return 1 ;; *) return 2 ;; esac
}

attest() {
    local id=$1 instruction=$2 rc
    answer "$instruction"; rc=$?
    case $rc in
        0) record "$id" PASS 'person observed and confirmed this control' ;;
        1) record "$id" FAIL 'person observed the control fail' ;;
        *) record "$id" UNMEASURED 'person skipped; no result inferred' ;;
    esac
    return "$rc"
}

pause_step() {
    local rc
    answer 'Have you completed exactly these steps in a separate, unrecorded terminal?'; rc=$?
    (( rc == 0 )) || exit 2
}

if (( $# != 0 )) || [[ $(uname -s) != Linux || ! -t 0 ]]; then
    record vm UNMEASURED 'requires Linux and an interactive terminal, with no arguments'
    exit 2
fi
printf 'M1: omarchy-test only; about 20-30 minutes; two person-controlled claude.ai subscription accounts. No login terminal may be recorded.\n'
attest vm 'Are you on the disposable omarchy-test VM, with no other test VM running and time for two interactive sign-ins?' || exit 2
for dependency in jq timeout mktemp stat find sort readlink; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
        record prerequisites UNMEASURED 'a required tool is missing; install it manually in the VM and start a fresh run'
        exit 2
    fi
done
claude_bin=$(type -P claude) || {
    record prerequisites UNMEASURED 'Claude executable missing; install it manually in the VM'
    exit 2
}
claude_bin=$(readlink -f -- "$claude_bin") || exit 2
record prerequisites PASS "required tools available; Claude executable=$claude_bin"

run_root=$(mktemp -d /tmp/genie-claude-isolation.XXXXXX) || exit 2
home_a=$run_root/claude-a
home_b=$run_root/claude-b
workspace=$run_root/workspace
marketplace=$run_root/marketplace
mkdir -m 700 -- "$home_a" "$home_b" "$workspace" "$marketplace" || exit 2

make_launcher() {
    local home=$1 launcher=$2
    # -p ignores BASH_ENV/imported shell functions. env -i prevents inherited API
    # keys, OAuth overrides, provider routing and config overrides from competing
    # with this home. Preserve only OS/browser context, never an auth variable.
    {
        printf '#!/bin/bash -p\nset +x +v\nset -uo pipefail\ncd %q || exit 1\n' "$workspace"
        printf 'exec env -i HOME="$HOME" PATH="$PATH" USER="${USER-}" LOGNAME="${LOGNAME-}" TERM="${TERM-xterm-256color}" LANG=C.UTF-8 DISPLAY="${DISPLAY-}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY-}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS-}" CLAUDE_CONFIG_DIR=%q %q "$@"\n' "$home" "$claude_bin"
    } >"$launcher" || exit 2
    chmod 700 -- "$launcher" || exit 2
}
launch_a=$run_root/run-a
launch_b=$run_root/run-b
make_launcher "$home_a" "$launch_a"
make_launcher "$home_b" "$launch_b"
printf 'Home A=%s\nHome B=%s\nShared disposable workspace=%s\nProvider identity/name/plan=unknown (not inferred from undocumented fields).\nUse /status in each provider TUI to verify the intended account; never copy that output into this harness.\n' "$home_a" "$home_b" "$workspace"

version=$(timeout 10 "$launch_a" --version 2>/dev/null)
if [[ $version =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    record cli-version PASS "Claude Code ${BASH_REMATCH[1]}; binary=$claude_bin"
else
    record cli-version UNMEASURED 'version unavailable; raw provider output suppressed'
fi
unset version

status_read() {
    local launcher=$1 home=$2 safe
    local -a fields=()
    safe=$(
        timeout 30 "$launcher" auth status 2>/dev/null |
            jq -r -s --arg expected "$home" '
                if length == 1 and (.[0] | type) == "object" then .[0] |
                    .authMethod as $method |
                    (if (["none","claude.ai","oauth_token","api_key","api_key_helper","third_party"] | index($method)) != null
                        then $method else "invalid" end),
                    (if has("configDirectory") then
                        if .configDirectory == $expected then "match" else "mismatch" end
                     else "unknown" end)
                else "invalid", "unknown" end' 2>/dev/null
        pipeline_codes=("${PIPESTATUS[@]}")
        printf '%s\n%s\n' "${pipeline_codes[0]}" "${pipeline_codes[1]}"
    )
    mapfile -t fields <<< "$safe"
    status_rc=unknown status_method=unknown status_directory=unknown last_status=''
    if (( ${#fields[@]} == 4 )) && [[ ${fields[3]} == 0 && ${fields[2]} =~ ^[01]$ && ${fields[0]} =~ ^(none|claude\.ai|oauth_token|api_key|api_key_helper|third_party)$ && ${fields[1]} =~ ^(match|mismatch|unknown)$ ]]; then
        status_rc=${fields[2]} status_method=${fields[0]} status_directory=${fields[1]}
        last_status="exit=$status_rc authMethod=$status_method configDirectory=$status_directory"
    fi
}

expect_status() {
    local id=$1 launcher=$2 home=$3 expected=$4 method=none
    status_read "$launcher" "$home"
    if [[ -z $last_status ]]; then
        record "$id" UNMEASURED 'unsupported/invalid status or timeout; raw output suppressed'
        return 2
    fi
    if [[ $status_directory == mismatch ]]; then
        record "$id" FAIL 'provider configDirectory differs from the selected home; value suppressed'
        last_status=''
        return 1
    fi
    if [[ $expected == 0 ]]; then method=claude.ai; fi
    if [[ $status_rc == "$expected" && $status_method == "$method" ]]; then
        record "$id" PASS "$last_status"
        return 0
    fi
    record "$id" FAIL "$last_status; required exit=$expected authMethod=$method (claude.ai subscriptions only)"
    return 1
}

config_check() {
    case $status_directory in
        match) record "$1" PASS 'documented configDirectory matches the selected absolute home' ;;
        mismatch) record "$1" FAIL 'configDirectory mismatch; value suppressed' ;;
        *) record "$1" UNMEASURED 'configDirectory unavailable; requires Claude Code v2.1.268 or later' ;;
    esac
}

unchanged() {
    if [[ -z $2 || -z $3 ]]; then
        record "$1" UNMEASURED 'a before/after observation is unavailable'
    elif [[ $2 == "$3" ]]; then
        record "$1" PASS "$4"
    else
        record "$1" FAIL 'the selected before/after observations differ; values suppressed'
    fi
}

credential_path() {
    local label=$1 path=$2/.credentials.json mode owner
    if [[ -L $path ]]; then
        record "credentials-$label" FAIL "credential path is a symlink: $path (not followed)"
    elif [[ -f $path ]]; then
        mode=$(stat -c '%a' -- "$path") || return 2
        owner=$(stat -c '%u' -- "$path") || return 2
        if [[ $mode == 600 && $owner == "$EUID" ]]; then
            record "credentials-$label" PASS "provider file exists at $path; owner/mode match; contents never opened"
        else
            record "credentials-$label" FAIL "unexpected owner/mode at $path; contents never opened"
        fi
    else
        record "credentials-$label" UNMEASURED "documented Linux path absent: $path; no alternate store inspected"
    fi
}

namespace_state() {
    # Compare ONLY non-credential artifact metadata. No file contents or hashes.
    local home=$1 suffix
    for suffix in settings.json projects plugins; do
        printf '%s\n' "$suffix"
        if [[ -L $home/$suffix ]]; then
            printf 'symlink-not-followed\n'
        elif [[ -f $home/$suffix ]]; then
            stat -c '%i:%s:%y:%z' -- "$home/$suffix" || return 1
        elif [[ -d $home/$suffix ]]; then
            find -P "$home/$suffix" -type f -printf '%P:%i:%s:%T@:%C@\n' | LC_ALL=C sort || return 1
        else
            printf 'absent\n'
        fi
    done
}

artifact_checks() {
    local label=$1 home=$2 suffix id present
    for suffix in settings.json projects plugins; do
        case $suffix in settings.json) id=settings ;; projects) id=history ;; plugins) id=plugins ;; esac
        if [[ -L $home/$suffix ]]; then
            record "$id-$label" FAIL "artifact root is a symlink: $home/$suffix (not followed)"
            continue
        fi
        present=''
        if [[ $suffix == settings.json && -f $home/$suffix ]]; then
            present=yes
        elif [[ -d $home/$suffix ]]; then
            present=$(find -P "$home/$suffix" -type f -print -quit)
        fi
        if [[ -n $present ]]; then
            record "$id-$label" PASS "provider-created artifact observed at $home/$suffix; paths/metadata only"
        else
            record "$id-$label" UNMEASURED "no artifact observed at $home/$suffix; not assumed from directory selection"
        fi
    done
}

# Both fresh-home observations precede every person-driven login.
expect_status fresh-A "$launch_a" "$home_a" 1; fresh_a=$?
config_check config-A
expect_status fresh-B "$launch_b" "$home_b" 1; fresh_b=$?
config_check config-B
b_before_a=$last_status
(( fresh_a == 0 && fresh_b == 0 )) || exit 2

printf '\nA sign-in: in a separate unrecorded terminal run:\n  %q auth login\nChoose your FIRST claude.ai subscription account in the provider browser flow. Confirm the intended account there; never paste its identity or login code here.\n' "$launch_a"
pause_step
expect_status login-A "$launch_a" "$home_a" 0; a_login_ok=$?
a_before_b=$last_status
expect_status B-after-login-A "$launch_b" "$home_b" 1; b_unchanged_ok=$?
unchanged login-A-keeps-B "$b_before_a" "$last_status" 'B auth status unchanged before/after A login'
(( a_login_ok == 0 && b_unchanged_ok == 0 )) || exit 2

printf '\nB sign-in: in a separate unrecorded terminal run:\n  %q auth login\nChoose your SECOND, DIFFERENT claude.ai subscription account; verify it in the provider UI.\n' "$launch_b"
pause_step
expect_status login-B "$launch_b" "$home_b" 0; b_login_ok=$?
expect_status A-after-login-B "$launch_a" "$home_a" 0; a_unchanged_ok=$?
unchanged login-B-keeps-A "$a_before_b" "$last_status" 'A auth status unchanged before/after B login'
(( b_login_ok == 0 && a_unchanged_ok == 0 )) || exit 2
attest distinct-accounts 'Did you verify two DIFFERENT claude.ai subscription identities in the provider UI (not Console, API-key, or an assumed browser default)?' || exit 2
credential_path A "$home_a"
credential_path B "$home_b"

# Text-only local fixtures. The PROVIDER installs them; the harness never writes
# user settings, installed-plugin registries, transcripts or credential files.
mkdir -p -- "$marketplace/.claude-plugin" || exit 2
cat >"$marketplace/.claude-plugin/marketplace.json" <<'JSON'
{"name":"genie-m1","owner":{"name":"Genie M1 measurement"},"plugins":[{"name":"m1-a","source":"./plugins/m1-a"},{"name":"m1-b","source":"./plugins/m1-b"}]}
JSON
for label in a b; do
    plugin=$marketplace/plugins/m1-$label
    mkdir -p -- "$plugin/.claude-plugin" "$plugin/skills/canary" || exit 2
    printf '{"name":"m1-%s","version":"1.0.0","description":"Text-only isolation canary"}\n' "$label" >"$plugin/.claude-plugin/plugin.json" || exit 2
    printf '%s\n' '---' 'name: canary' 'description: A harmless account-isolation canary' 'disable-model-invocation: true' '---' \
        "Reply exactly GENIE_M1_${label^^}_${run_root##*/}. Do not use tools, read files, or change anything." >"$plugin/skills/canary/SKILL.md" || exit 2
done

b_artifacts_before=$(namespace_state "$home_b") || exit 2
printf '\nA settings/history/plugins: in a separate unrecorded terminal run:\n  %q plugin marketplace add %q\n  %q plugin install m1-a@genie-m1 --scope user\n  %q\nInside the provider TUI, run /m1-a:canary. Confirm the canary is GENIE_M1_A_%s, then /exit. Do not use project scope or --plugin-dir.\n' "$launch_a" "$marketplace" "$launch_a" "$launch_a" "${run_root##*/}"
pause_step
artifact_checks A "$home_a"
b_artifacts_after=$(namespace_state "$home_b") || exit 2
unchanged A-keeps-B-artifacts "$b_artifacts_before" "$b_artifacts_after" 'B settings/history/plugins metadata unchanged while A created its artifacts'
a_artifacts_before=$(namespace_state "$home_a") || exit 2

printf '\nB settings/history/plugins: in a separate unrecorded terminal run:\n  %q plugin marketplace add %q\n  %q plugin install m1-b@genie-m1 --scope user\n  %q\nInside the provider TUI, run /m1-b:canary. Confirm the canary is GENIE_M1_B_%s and A-only m1-a is not installed in B, then /exit.\n' "$launch_b" "$marketplace" "$launch_b" "$launch_b" "${run_root##*/}"
pause_step
artifact_checks B "$home_b"
a_artifacts_after=$(namespace_state "$home_a") || exit 2
unchanged B-keeps-A-artifacts "$a_artifacts_before" "$a_artifacts_after" 'A settings/history/plugins metadata unchanged while B created its artifacts'

printf '\nResume A in the SAME workspace (launcher sets it):\n  %q --continue\nConfirm its last conversation contains only the A canary, its identity is A, and B-only m1-b is absent. Do not send a new prompt yet. Close with /exit.\n' "$launch_a"
attest resume-A 'Did the real A resume show A identity/canary and no B-only plugin?' || exit 2
printf '\nResume B:\n  %q --continue\nConfirm B identity/canary; open /resume and verify A canary is absent from normal B session discovery. Close without creating another conversation.\n' "$launch_b"
attest resume-B 'Did B resume only B and exclude A from its normal resume picker?' || exit 2

printf '\nPositive gauge control: deliberately use A home for the B test slot:\n  %q --continue\nThe observer must detect A identity AND A canary. Exit, restore B with:\n  %q --continue\nThe observer must now detect B identity AND B canary. Exit.\n' "$launch_a" "$launch_b"
attest shared-home-gauge 'Did deliberately sharing A home reveal A, and restoring B home reveal B?' || exit 2

printf '\nConcurrency: open TWO unrecorded terminals and keep both running:\n  %q --continue\n  %q --continue\nConfirm A and B identities/canaries are still distinct.\n' "$launch_a" "$launch_b"
attest concurrent-sessions 'Are both provider sessions open simultaneously on their intended accounts?' || exit 2
expect_status concurrent-A "$launch_a" "$home_a" 0 || exit 2
a_before_logout=$last_status
printf '\nWhile A stays open, in a THIRD unrecorded terminal log out B ONLY:\n  %q auth logout\nClose the old B session without sending another request. Do not log out A.\n' "$launch_b"
pause_step
expect_status logout-B "$launch_b" "$home_b" 1
expect_status A-after-logout-B "$launch_a" "$home_a" 0
unchanged logout-B-keeps-A "$a_before_logout" "$last_status" 'A auth status unchanged by B-only logout'
printf 'In the still-open A session, ask it to reply with its A canary; observe a real successful answer, not just auth status.\n'
attest A-still-answers 'Did A answer successfully with its own canary while B was signed out?' || exit 2

a_before_relogin=$last_status
printf '\nRe-login B manually, keeping A open:\n  %q auth login\nChoose the SAME B account, explicitly confirm it in the provider UI, then close/restart B with --continue.\n' "$launch_b"
pause_step
expect_status relogin-B "$launch_b" "$home_b" 0
expect_status A-after-relogin-B "$launch_a" "$home_a" 0
unchanged relogin-B-keeps-A "$a_before_relogin" "$last_status" 'A auth status unchanged by B re-login'

printf '\nRestart control: close BOTH test provider sessions, then start fresh processes:\n  %q --continue\n  %q --continue\nConfirm each identity and its own canary survive. B must not acquire A history. Close both test sessions.\n' "$launch_a" "$launch_b"
pause_step
expect_status restart-A "$launch_a" "$home_a" 0
expect_status restart-B "$launch_b" "$home_b" 0
attest restart-resume 'After restarting both processes, did each resume its own identity/canary, without cross-account history?' || exit 2
exit 0
