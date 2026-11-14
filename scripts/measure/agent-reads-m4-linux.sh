#!/usr/bin/env bash
# ONE opt-in Tynn #564 diagnostic on Azure Omarchy D8ads_v5, in its logged-on Hyprland session.
# 12 complete alternating pairs (6 each order), original 5 opens, separate extra stage opens, no M5/M6.
# This is descriptive evidence, NEVER acceptance. The earlier 1.2070 > 1.2 FAIL stands.
# Outer queue job writes ci-measure564-source.txt (full queued SHA, provenance only), then invokes this script.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [ "$(id -un)" != genie ]; then echo 'This diagnostic runs only as genie on a test VM.' >&2; exit 2; fi
if [ ! -f ci-measure564-source.txt ]; then echo 'Missing queued source provenance.' >&2; exit 2; fi
source_commit="$(tr -d '\r\n' < ci-measure564-source.txt)"
if [[ ! "$source_commit" =~ ^[a-fA-F0-9]{40}$ ]]; then echo 'Queued source provenance must be the full commit SHA.' >&2; exit 2; fi
echo "QUEUED_SOURCE_COMMIT $source_commit (provenance; build identity is measured independently)"
echo "MACHINE $(hostname) cores=$(nproc) user=$(id -un)"
# Only the session display allowlist is inherited from the logged-on user manager, never arbitrary shell code.
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
run_name="agent-reads-m4-564-$(date -u +%Y%m%d-%H%M%S)-$$"
report_dir="$PWD/ci-out/$run_name"
run_log="$PWD/ci-out/$run_name.log"
set +e
node scripts/agent-reads-m4-diagnostic.mjs "--out-dir=$report_dir" 2>&1 | tee "$run_log"
pipeline_status=("${PIPESTATUS[@]}")
diagnostic_exit=${pipeline_status[0]}
if [ "$diagnostic_exit" -eq 0 ] && [ "${pipeline_status[1]}" -ne 0 ]; then diagnostic_exit=${pipeline_status[1]}; fi
set -e
if [ "$diagnostic_exit" -eq 0 ]; then
    node --input-type=module -e '
        import {readFileSync} from "node:fs";
        const s=JSON.parse(readFileSync(process.argv[1],"utf8"));
        const pairs=s.report?.pairs;
        if(s.kind!=="m4-diagnostic" || s.finished!==true || s.acceptance!==false || "pass" in s || pairs?.length!==12) process.exit(1);
        for(let i=0;i<12;i++) {
            const p=pairs[i], order=i%2===0?["ipc","door"]:["door","ipc"];
            if(JSON.stringify(p.order)!==JSON.stringify(order) || !p.ipc || !p.door) process.exit(1);
        }
    ' "$report_dir/summary.json" || diagnostic_exit=$?
fi
if [ -d "$report_dir" ]; then cp ci-measure564-source.txt "$report_dir/queued-source-commit.txt"; fi
echo "DIAGNOSTIC_EXIT $diagnostic_exit artifacts=$report_dir log=$run_log NOT_ACCEPTANCE"
exit "$diagnostic_exit"
