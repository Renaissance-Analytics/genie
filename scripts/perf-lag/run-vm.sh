#!/usr/bin/env bash
# THE RESTART LAG, MEASURED ON A TEST VM (genie#1340). Never on the owner's desktop.
#
#   bash scripts/perf-lag/run-vm.sh <label>:<base|probe>:<scale>:<seconds> ...
#
# base = this tree as built; probe = this tree with probe-tail.mjs applied (applied once, from then on). Each item: a
# fresh seed (eleven agents, threads the owner's size × scale, all cut off mid-turn), the page cache dropped (a restart
# reads cold), Genie launched with CDP on 9222 and main's inspector on 9229, measure.mjs for <seconds>, Genie ended.
# Results land in perf-out/.
set -u
export DISPLAY=:0
mkdir -p perf-out
echo "=== npm ci"
npm ci --no-audit --no-fund >perf-out/ci.log 2>&1 || { tail -30 perf-out/ci.log; exit 1; }
echo "=== build"
npm run build >perf-out/build.log 2>&1 || { tail -30 perf-out/build.log; exit 1; }
chmod +x scripts/perf-lag/stub-codex-busy.mjs
export GENIE2_CODEX_BINARY="$PWD/scripts/perf-lag/stub-codex-busy.mjs"
echo "cpus $(nproc)"; free -m | head -2
probed=0

# GENIE GONE BEFORE THE NEXT ONE STARTS: a Genie still quitting holds the single-instance lock and CDP's port, so the next
# launch would hand off to it and be measured as it; and a survivor keeps this ssh session open after the run (it did,
# 2026-10-30: the Electron of the last item outlived pkill and the run hung for hours). TERM, wait, then KILL.
end_genie() {
    pkill -f 'electron/dist/electron' 2>/dev/null; pkill -x electron 2>/dev/null
    for _ in $(seq 1 30); do pgrep -f 'electron/dist/electron' >/dev/null || return 0; sleep 1; done
    pkill -9 -f 'electron/dist/electron' 2>/dev/null; pkill -9 -f 'npm exec electron' 2>/dev/null; sleep 1
}

for item in "$@"; do
    IFS=: read -r label variant scale seconds <<<"$item"
    if [ "$variant" = probe ] && [ "$probed" = 0 ]; then
        node scripts/perf-lag/probe-tail.mjs && npm run build:main >perf-out/build-probe.log 2>&1 || { tail -30 perf-out/build-probe.log; exit 1; }
        probed=1
    fi
    end_genie
    rm -rf "$HOME/.genie" "$HOME/lagws" "$HOME/.config/genie2"
    echo "=== seed $label ($variant, scale $scale)"
    node scripts/perf-lag/seed.mjs "$scale" | tail -2
    sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
    echo "=== launch $label"
    export LAUNCHED_AT_MS="$(date +%s%3N)"
    setsid npx electron --inspect=9229 . --ozone-platform=x11 --remote-debugging-port=9222 >"perf-out/$label-electron.log" 2>&1 </dev/null &
    pid=$!
    (cd perf-out && timeout $((seconds + 300)) node ../scripts/perf-lag/measure.mjs "$label" "$seconds") || echo "measure.mjs exited $?"
    kill -- -"$pid" 2>/dev/null; end_genie
    grep -iE "fatal|out of memory|heap limit|uncaught" "perf-out/$label-electron.log" | head -10
done
ls -la perf-out
