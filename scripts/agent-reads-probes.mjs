/** Page expressions shared by ordinary reads and their physically injected measurement controls (Tynn #564). */
export function busyWorkProbe(extraWorkMs) {
    if (!Number.isFinite(extraWorkMs) || extraWorkMs < 0 || extraWorkMs > 60_000) throw new Error('work budget must be between 0 and 60000 ms');
    if (extraWorkMs === 0) return '0';
    return `(() => {
        const began = performance.now();
        while (performance.now() - began < ${extraWorkMs}) {}
        return performance.now() - began;
    })()`;
}

export function ledgerProbe(agentId, rows, extraWorkMs = 0) {
    if (typeof agentId !== 'string' || agentId.length === 0) throw new Error('agent ID is required');
    if (!Number.isSafeInteger(rows) || rows < 1) throw new Error('row count must be a positive safe integer');
    const work = busyWorkProbe(extraWorkMs);
    return `new Promise((resolve, reject) => {
        window.__gauge.reset();
        const started = performance.now();
        let settled = false, unsubscribe = null;
        const stop = () => { const off = unsubscribe; unsubscribe = null; if (off) off(); };
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            stop();
            reject(new Error('no whole detail within 120 s'));
        }, 120000);
        try {
            unsubscribe = window.genieTest.subscribeAgent(${JSON.stringify(agentId)}, (detail) => {
                if (settled || (detail?.rows?.length ?? 0) < ${rows}) return;
                settled = true;
                clearTimeout(timer);
                try {
                    ${work};
                    const ms = performance.now() - started;
                    stop();
                    requestAnimationFrame(() => setTimeout(() => resolve({ ms, maxGapMs: window.__gauge.max() }), 0));
                } catch (error) { stop(); reject(error); }
            });
            // A cached full detail may be delivered synchronously, before subscribeAgent returns its release function.
            if (settled) stop();
        } catch (error) { settled = true; clearTimeout(timer); stop(); reject(error); }
    })`;
}

export function snapshotProbe(extraWorkMs = 0) {
    const work = busyWorkProbe(extraWorkMs);
    return `(async () => {
        const started = performance.now();
        await window.genieTest.snapshot();
        ${work};
        return performance.now() - started;
    })()`;
}
