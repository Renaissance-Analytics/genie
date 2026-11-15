/** Aggregate heap statistics only: force GC before/after the timed run, never during its raw samples. */
export function createHeapSampler(cdp, now = () => performance.now()) {
    let phase = 'new', started = 0, before = 0;
    const series = [];
    const command = async (method) => {
        const frame = await cdp.send(method, {}, 30_000);
        if (frame?.error) throw new Error(`${method}: ${frame.error.message ?? 'CDP refused the command'}`);
        if (!frame?.result || typeof frame.result !== 'object') throw new Error(`${method}: missing CDP result`);
        return frame.result;
    };
    const read = async () => {
        const { usedSize } = await command('Runtime.getHeapUsage');
        if (typeof usedSize !== 'number' || !Number.isFinite(usedSize) || usedSize <= 0) throw new Error('invalid heap usedSize');
        return usedSize;
    };
    const requireRunning = () => {
        if (phase !== 'running') throw new Error(`heap baseline must be started; sampler is ${phase}`);
    };
    const record = (kind, usedBytes) => {
        const elapsedMs = now() - started;
        if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('invalid heap sample clock');
        series.push({ phase: kind, elapsedMs, usedBytes });
    };
    return {
        async start() {
            if (phase !== 'new') throw new Error(`heap baseline already started; sampler is ${phase}`);
            phase = 'starting';
            try {
                await command('HeapProfiler.collectGarbage'); before = await read(); started = now();
                if (!Number.isFinite(started)) throw new Error('invalid heap baseline clock');
                series.push({ phase: 'baseline', elapsedMs: 0, usedBytes: before }); phase = 'running';
            } catch (error) { phase = 'failed'; throw error; }
        },
        async sample() {
            requireRunning(); phase = 'sampling';
            try { record('stream', await read()); phase = 'running'; }
            catch (error) { phase = 'failed'; throw error; }
        },
        async finish() {
            requireRunning(); phase = 'finishing';
            try {
                await command('HeapProfiler.collectGarbage'); const after = await read(); record('after-gc', after);
                phase = 'finished';
                return { heapBeforeBytes: before, heapAfterGcBytes: after, gc: true, heapSeries: structuredClone(series) };
            } catch (error) { phase = 'failed'; throw error; }
        },
    };
}
