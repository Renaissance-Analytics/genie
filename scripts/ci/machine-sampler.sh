#!/usr/bin/env bash
# THE MACHINE, EVERY ~2 s, BESIDE THE WHOLE GATE (Tynn #660). linux.sh starts it on its own pid; it writes one line per
# sample to <out> and ends when that pid is gone, or after <seconds>, whichever is first. scripts/ci/stall.mjs reads the
# lines to say whether the machine stalled during a row (a row that failed then is INFRA and rerun once).
#
#   bash scripts/ci/machine-sampler.sh <out> <gate-pid> [interval-s=2] [seconds=14400]
#
#   MACHINE <epoch-ms> gap=<ms since the last sample> cpu=<busy %> steal=<hypervisor %> io_some=<%> io_full=<%>
#           mem_full=<%> load=<1-min>
#
# cpu and steal are this interval's, from /proc/stat; io_* and mem_full are the kernel's pressure figures (PSI avg10: the
# share of the last 10 s some / every runnable task was stalled). `gap` is the sampler's own clock: a gap far past the
# interval means the VM itself was not run. Observe only: it changes nothing and writes only <out>.
out="${1:?usage: machine-sampler.sh <out> <gate-pid> [interval] [seconds]}"
gate="${2:?usage: machine-sampler.sh <out> <gate-pid> [interval] [seconds]}"
interval="${3:-2}"
limit="${4:-14400}"

psi() { [ -r "/proc/pressure/$1" ] && awk -v k="$2" '$1 == k { split($2, a, "="); print a[2]; exit }' "/proc/pressure/$1" || echo -; }
# The cpu line of /proc/stat: user nice system idle iowait irq softirq steal.
read_stat() { read -r _ s_user s_nice s_sys s_idle s_iow s_irq s_soft s_steal _ < /proc/stat; }

read_stat
p_total=$((s_user + s_nice + s_sys + s_idle + s_iow + s_irq + s_soft + s_steal))
p_idle=$((s_idle + s_iow))
p_steal=$s_steal
p_ms="$(date +%s%3N)"
end=$((SECONDS + limit))
while [ "$SECONDS" -lt "$end" ] && kill -0 "$gate" 2>/dev/null; do
    sleep "$interval"
    now="$(date +%s%3N)"
    read_stat
    total=$((s_user + s_nice + s_sys + s_idle + s_iow + s_irq + s_soft + s_steal))
    d=$((total - p_total)); [ "$d" -gt 0 ] || d=1
    busy=$(( (d - (s_idle + s_iow - p_idle) - (s_steal - p_steal)) * 100 / d ))
    steal=$(( (s_steal - p_steal) * 100 / d ))
    printf 'MACHINE %s gap=%s cpu=%s steal=%s io_some=%s io_full=%s mem_full=%s load=%s\n' \
        "$now" "$((now - p_ms))" "$busy" "$steal" "$(psi io some)" "$(psi io full)" "$(psi memory full)" "$(cut -d' ' -f1 /proc/loadavg)" >> "$out"
    p_total=$total; p_idle=$((s_idle + s_iow)); p_steal=$s_steal; p_ms=$now
done
