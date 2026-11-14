/** Test-harness ticker identities. The existing tick/PID prefix remains readable by older row gauges. */
export function providerTickLine(tick, provider) {
    return `tick ${tick} pid ${provider.pid} generation ${provider.generation} born ${provider.bornAt}\n`;
}

export function providerTicks(rows) {
    return [...JSON.stringify(rows ?? []).matchAll(/tick (\d+) pid (\d+) generation ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) born (\d+)/g)]
        .map(m => ({ tick: Number(m[1]), pid: Number(m[2]), generation: m[3], bornAt: Number(m[4]) }));
}

const keyOf = tick => JSON.stringify([tick.pid, tick.generation, tick.bornAt]);

/** The same process generation must advance after Start; PID reuse and old history cannot decide the result. */
export function freshProviderGauge({ startedAt, before }) {
    const previous = new Set(before.map(keyOf));
    let ticks = [], reason = 'no ticks';
    let observed = null;
    const reject = why => { reason = why; return null; };
    return {
        observe(reading, alive) {
            ticks = reading.ticks.slice(-8);
            const latest = ticks.at(-1);
            if (!reading.running) { observed = null; return reject('the session is not running'); }
            if (!latest) return reject('no generation-stamped tick reached the window');
            const key = keyOf(latest);
            if (previous.has(key)) return reject('this generation was observed before Start');
            if (latest.bornAt < startedAt) return reject('this generation predates Start');
            if (!Number.isSafeInteger(latest.pid) || latest.pid <= 0 || !alive(latest.pid)) {
                observed = null; return reject('the provider PID is not alive');
            }
            if (!observed || observed.key !== key) {
                observed = { key, tick: latest.tick };
                return reject('waiting for another tick from this generation');
            }
            if (latest.tick <= observed.tick) return reject('this generation has not advanced');
            observed.tick = latest.tick;
            reason = 'a fresh generation advanced';
            return latest;
        },
        diagnostics: () => ({ reason, startedAt, ticks }),
    };
}
