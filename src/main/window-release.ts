/*
 * WHEN AN ENDED WINDOW HAS LET GO (Tynn #400). After a hang genie-host ends the window and starts a new one. On Windows
 * a killed process leaves the process table before the sockets it held are closed: CI read the ended window's pid gone
 * while its debugger and inspector ports were still listening, and the new window, started in that moment, found a
 * port taken and came up without it. So the new window waits until the old one's process is gone AND no socket is
 * still owned by it. Bounded (10 s by default): at the bound this answers false, and the caller opens the window
 * anyway, so a person is never left with Genie gone.
 */
export interface WindowReleasePorts {
    readonly alive: (pid: number) => boolean;
    /** Sockets the OS still lists as owned by the pid (Windows: netstat). Elsewhere a process's sockets close with it: 0. */
    readonly sockets: (pid: number) => Promise<number>;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly boundMs?: number;
    readonly stepMs?: number;
}

export async function windowReleased(pid: number, ports: WindowReleasePorts): Promise<boolean> {
    const now = ports.now ?? Date.now;
    const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const bound = ports.boundMs ?? 10_000;
    const step = ports.stepMs ?? 100;
    const end = now() + bound;
    for (;;) {
        if (!ports.alive(pid) && (await ports.sockets(pid)) === 0) return true;
        if (now() >= end) return false;
        await sleep(step);
    }
}
