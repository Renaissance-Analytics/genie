/**
 * TAILSCALE, LIVE (Tynn #748, #749; the LiftPoint onboarding, 2026-11-16). Genie's one view of Tailscale on this machine.
 *
 * #748: Install Tailscale started the installer twice. Genie read Tailscale once right after the installer opened (still
 * absent: the person had not clicked through it yet), so Settings went on offering the same Install button with nothing to
 * say the click had been taken, and the next click downloaded and opened a second installer. Install is now ONE run at a
 * time (a click during the download or the signature check joins it), and once the installer is open a click starts
 * nothing until Tailscale is there or the wait below ends. The status says so (`installing`), so the button shows it.
 *
 * #749: Genie read Tailscale at boot and right after a click, never again, so a Tailscale installed or signed in from its
 * own window was not noticed until Genie was shut down and relaunched. Genie now reads it again on its own, every
 * `everyMs`, while it waits for something to happen: after the installer opens, after Connect hands back a sign-in link,
 * and while Remote access is open on a Tailscale that is not connected. The wait is bounded (`forMs`) and one at a time:
 * never a poll left running. The read that first finds Tailscale connected applies remote access (`online`), so the
 * listener binds then, without a relaunch.
 *
 * Nothing here elevates or runs an installer on its own (Tynn #753): `install` runs only from a person's Install click.
 */
import type { TailscaleStatus, TailscaleUpResult } from './tailscale-cli.js';

export interface InstallAnswer { readonly started: boolean; readonly url?: string; readonly message?: string }

export interface TailscaleLivePorts {
    /** Read Tailscale now (getTailscaleStatus). */
    readonly probe: () => Promise<TailscaleStatus>;
    /** Download, check and open Tailscale's installer (installTailscale). Only from a person's click. */
    readonly install: () => Promise<InstallAnswer>;
    /** Bring this node online (tailscaleUp). */
    readonly up: () => Promise<TailscaleUpResult>;
    /** Tailscale is newly connected: apply remote access, so the listener binds now. */
    readonly online: () => Promise<void>;
    /** The status changed: push it to the windows. */
    readonly changed: () => void;
    readonly timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
    readonly now?: () => number;
    /** How often Genie reads Tailscale while it waits. */
    readonly everyMs?: number;
    /** How long it waits before it stops reading (an installer left open, a sign-in never finished). */
    readonly forMs?: number;
    /** Where a failed `online` is told; absent = dropped. */
    readonly say?: (text: string) => void;
}

export interface TailscaleLive {
    /** The last reading, with `installing` while Genie's own Install is under way; `null` before the first read. */
    status(): TailscaleStatus | null;
    /** Read Tailscale now. */
    refresh(): Promise<TailscaleStatus | null>;
    /** Remote access opened, Restart, or a window focused: read now, and keep reading while Tailscale is not connected. */
    look(): Promise<TailscaleStatus | null>;
    install(): Promise<InstallAnswer>;
    up(): Promise<TailscaleUpResult>;
    /** Stop any wait (the host is going down). */
    stop(): void;
}

const ALREADY_OPEN = 'Tailscale’s installer is already open: finish it there.';

export function tailscaleLive(ports: TailscaleLivePorts): TailscaleLive {
    // A wait never holds the process open: the host exits when it is done, whatever Genie was waiting for.
    const timers = ports.timers ?? { set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms).unref(), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    const now = ports.now ?? Date.now;
    const everyMs = ports.everyMs ?? 3_000;
    const forMs = ports.forMs ?? 15 * 60_000;

    let last: TailscaleStatus | null = null;
    let reading: Promise<TailscaleStatus | null> | null = null;
    let installing: Promise<InstallAnswer> | null = null;
    /** The installer Genie opened is (as far as Genie knows) still open: Tailscale was absent at the last read. */
    let installerOpen = false;
    let waitUntil = 0;
    let timer: unknown = null;
    let stopped = false;

    const view = (): TailscaleStatus | null => {
        const under = installing !== null || (installerOpen && (last?.state ?? 'absent') === 'absent');
        if (!last) return null;
        return under ? { ...last, installing: true } : last;
    };

    /**
     * Tell the windows only what is new: a wait reads Tailscale every few seconds, and a reading the same as the last one
     * pushed is not worth a snapshot to every window.
     */
    let pushed = '';
    const push = (): void => {
        const now = JSON.stringify(view());
        if (now === pushed) return;
        pushed = now;
        ports.changed();
    };

    const read = async (): Promise<TailscaleStatus | null> => {
        const was = last?.state ?? null;
        try {
            last = await ports.probe();
        } catch {
            // A read that failed tells nothing new; keep the last one.
        }
        if (last && last.state !== 'absent') installerOpen = false;
        if (last?.state === 'running' && was !== 'running') {
            await ports.online().catch((error: unknown) => ports.say?.(`remote: ${error instanceof Error ? error.message : String(error)}`));
        }
        push();
        return view();
    };

    /** One read at a time: a read asked for while one runs gets that one's answer. */
    const refresh = (): Promise<TailscaleStatus | null> => {
        if (!reading) reading = read().finally(() => { reading = null; });
        return reading;
    };

    const endWait = (): void => {
        if (timer !== null) timers.clear(timer);
        timer = null;
        if (installerOpen) { installerOpen = false; push(); }
    };

    const tick = (): void => {
        timer = null;
        void refresh().then(() => {
            if (stopped) return;
            if (last?.state === 'running' || now() >= waitUntil) { endWait(); return; }
            timer = timers.set(tick, everyMs);
        });
    };

    /** Keep reading until Tailscale is connected, for `forMs` from now; a wait already running is extended, never doubled. */
    const watch = (): void => {
        if (stopped || last?.state === 'running') return;
        waitUntil = now() + forMs;
        if (timer === null) timer = timers.set(tick, everyMs);
    };

    return {
        status: view,
        refresh,
        look: async () => { const s = await refresh(); if (s?.state !== 'running') watch(); return view(); },
        install: () => {
            if (installing) return installing;
            if (installerOpen && (last?.state ?? 'absent') === 'absent') return Promise.resolve({ started: false, message: ALREADY_OPEN });
            installing = (async () => {
                try {
                    const answer = await ports.install();
                    if (answer.started) { installerOpen = true; watch(); }
                    return answer;
                } finally {
                    installing = null;
                    push();
                }
            })();
            push();
            return installing;
        },
        up: async () => {
            const answer = await ports.up();
            await refresh();
            if (last?.state !== 'running') watch();
            void answer.online?.then(() => refresh()).catch(() => {});
            return answer;
        },
        stop: () => { stopped = true; if (timer !== null) timers.clear(timer); timer = null; },
    };
}
