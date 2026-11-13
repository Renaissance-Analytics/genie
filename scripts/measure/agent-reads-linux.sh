#!/usr/bin/env bash
# Opt-in Tynn #564 M4-M6 job: Azure Omarchy D8ads_v5, logged-on Hyprland session, never the owner's desktop.
# Outer queue .sh job writes ci-measure564-source.txt (full queued SHA, provenance only), then runs this script.
# Both parent and samplers fingerprint actual fresh artifacts; no gate row and no performance-budget adjustment.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [ "$(id -un)" != genie ]; then echo 'This measurement runs only as genie on a test VM.' >&2; exit 2; fi
if [ ! -f ci-measure564-source.txt ]; then echo 'Missing queued source provenance.' >&2; exit 2; fi
source_commit="$(tr -d '\r\n' < ci-measure564-source.txt)"
if [[ ! "$source_commit" =~ ^[a-fA-F0-9]{40}$ ]]; then echo 'Queued source provenance must be the full commit SHA.' >&2; exit 2; fi
echo "QUEUED_SOURCE_COMMIT $source_commit (provenance; build identity is measured independently)"
echo "MACHINE $(hostname) cores=$(nproc) user=$(id -un)"
# SSH's XDG_SESSION_TYPE can be tty even with WAYLAND_DISPLAY. Take the display allowlist from the real user manager.
session_environment="$(systemctl --user show-environment)"
while IFS= read -r line; do
    case "$line" in
        XDG_SESSION_TYPE=*|XDG_CURRENT_DESKTOP=*|XDG_SESSION_DESKTOP=*|WAYLAND_DISPLAY=*|DISPLAY=*|HYPRLAND_INSTANCE_SIGNATURE=*) export "$line" ;;
    esac
done <<< "$session_environment"
if [ "${XDG_SESSION_TYPE:-}" != wayland ] || [ -z "${WAYLAND_DISPLAY:-}" ] || [ ! -S "${XDG_RUNTIME_DIR:-/nonexistent}/$WAYLAND_DISPLAY" ]; then
    echo 'A logged-on Hyprland Wayland session is required.' >&2; exit 2
fi
echo "DISPLAY type=$XDG_SESSION_TYPE wayland=$WAYLAND_DISPLAY desktop=${XDG_CURRENT_DESKTOP:-unknown}"
export CRASH_CDP_ALLOW=1 GENIE_TEST_MACHINE=1
bash scripts/ci/linux.sh --only build
chmod u+x scripts/stub-codex.mjs
npx --no-install tsc -p tsconfig.json --noEmit
run_name="agent-reads-564-$(date -u +%Y%m%d-%H%M%S)-$$"
report_dir="$PWD/ci-out/$run_name"
run_log="$PWD/ci-out/$run_name.log"
set +e
node scripts/agent-reads-paired.mjs "--out-dir=$report_dir" 2>&1 | tee "$run_log"
pipeline_status=("${PIPESTATUS[@]}")
measurement_exit=${pipeline_status[0]}
if [ "$measurement_exit" -eq 0 ] && [ "${pipeline_status[1]}" -ne 0 ]; then measurement_exit=${pipeline_status[1]}; fi
set -e
if [ "$measurement_exit" -eq 0 ]; then
    node --input-type=module -e 'import {readFileSync} from "node:fs"; const s=JSON.parse(readFileSync(process.argv[1],"utf8")); if(s.pass!==true || s.finished!==true) process.exit(1);' "$report_dir/summary.json" || measurement_exit=$?
fi
if [ -d "$report_dir" ]; then cp ci-measure564-source.txt "$report_dir/queued-source-commit.txt"; fi
echo "MEASUREMENT_EXIT $measurement_exit artifacts=$report_dir log=$run_log"
exit "$measurement_exit"
