/** Test-harness ticker identities. The existing tick/PID prefix remains readable by older row gauges. */
export function providerTickLine(tick, provider) {
    return `tick ${tick} pid ${provider.pid} generation ${provider.generation} born ${provider.bornAt}\n`;
}

export function providerTicks(rows) {
    return [...JSON.stringify(rows ?? []).matchAll(/tick (\d+) pid (\d+) generation ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) born (\d+)/g)]
        .map(m => ({ tick: Number(m[1]), pid: Number(m[2]), generation: m[3], bornAt: Number(m[4]) }));
}

/** RED checkpoint: preserve E3's former PID predicate before measuring the generation/advancement controls. */
export function freshProviderGauge({ startedAt, before }) {
    const previousPids = new Set(before.map(tick => tick.pid));
    let ticks = [], reason = 'no ticks';
    return {
        observe(reading, alive) {
            ticks = reading.ticks.slice(-8);
            const latest = ticks.at(-1);
            if (!reading.running || !latest || !alive(latest.pid) || previousPids.has(latest.pid)) { reason = 'old PID or no live provider'; return null; }
            return latest;
        },
        diagnostics: () => ({ reason, startedAt, ticks }),
    };
}
