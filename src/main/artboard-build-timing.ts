interface PhaseEvent {
    phase: 'native-build' | 'resolve-board' | 'projection'; mode: 'async' | 'sync';
    startedMs: number; endedMs: number; elapsedMs: number; processCpuMs: number; syncMs: number | null;
}
interface PhaseTrace { events: PhaseEvent[]; dropped: number }
interface TimingPorts { enabled: boolean; trace?: PhaseTrace | undefined; now(): number; cpuUsage(): NodeJS.CpuUsage }
const noop = () => {};

/** Owned PAGE_PROBE diagnostics only: no bodies, paths or args. Process CPU is not main-thread-only CPU. */
export function beginArtboardBuildTiming(phase: PhaseEvent['phase'], mode: PhaseEvent['mode'], injected?: TimingPorts): () => void {
    try {
        const ports = injected ?? { enabled: process.env.GENIE_PAGE_PROBE === '1', trace: (globalThis as { __artboardPhases?: PhaseTrace }).__artboardPhases, now: () => performance.now(), cpuUsage: () => process.cpuUsage() };
        if (!ports.enabled || !ports.trace) return noop;
        const trace = ports.trace, startedMs = ports.now(), initialCpu = ports.cpuUsage(); let finished = false;
        return () => {
            if (finished) return; finished = true;
            try {
                const endedMs = ports.now(), cpu = ports.cpuUsage(), elapsedMs = Math.max(0, endedMs - startedMs);
                if (trace.events.length >= 128) { trace.dropped++; return; }
                trace.events.push({ phase, mode, startedMs, endedMs, elapsedMs, processCpuMs: Math.max(0, (cpu.user - initialCpu.user + cpu.system - initialCpu.system) / 1000), syncMs: mode === 'sync' ? elapsedMs : null });
            } catch { /* A failed measurement cannot replace the application's result or error. */ }
        };
    } catch { return noop; }
}
