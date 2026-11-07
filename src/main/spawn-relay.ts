import { fork as forkChild } from 'node:child_process';
import { parseSpawnFrame, type SpawnFrame } from './spawn-host-protocol.js';

/**
 * GENIE-HOST'S SPAWN-HOST CHILDREN (the host split, P2.1: `.ai/plans/genie-2-host-split-2026-10-31.md` §11a).
 *
 * The window used to fork #1405's spawn host itself, and the spawn host died with the window — so did every site, queue
 * worker and terminal. Under genie-host the HOST forks it (the plan's D1: the pty host below the host), in two profiles of
 * the same entry, and relays frames to and from the window over the engine link:
 *  - `processes`: exec, streams, supervised ptys (sites, queue workers, the front door) — no cwd hook;
 *  - `terminals`: interactive shells, with fancy-term's OSC-7 cwd hook (the engine's settings are global per process).
 *
 * A child that dies takes its ptys with it. Their helpers are ended by pid, and each pty is reported exited (-1) to the
 * window only once its helper is gone — #1405's lesson (genie-test-windows: reported at once, restarts raced the dying
 * process for its port and backed off for minutes). Then the child is started again, with backoff.
 *
 * Every port (the fork, the clock, the OS) is injectable: the relay is tested without a process.
 */

// `supervised` (P3.3b): the host's OWN process supervisor's ptys — its frames go to a client inside the host, never a window.
export const SPAWN_PROFILES = ['processes', 'terminals', 'supervised'] as const;
export type SpawnProfile = (typeof SPAWN_PROFILES)[number];

/** A forked child as the relay uses it (a node ChildProcess with an IPC channel). */
export interface RelayChild {
    readonly pid?: number | undefined;
    readonly connected: boolean;
    send(frame: SpawnFrame): boolean;
    kill(): boolean;
    on(event: 'message', listener: (message: unknown) => void): unknown;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface SpawnRelayOptions {
    /** The spawn host's entry (dist/main/spawn-host.js next to host.js; a test's .ts under tsx). */
    readonly entry: string;
    /** Frames from a child, for the windows (SessionEngineServer.spawnFrame). */
    readonly send: (profile: SpawnProfile, frame: SpawnFrame) => void;
    readonly fork?: (entry: string, env: Record<string, string>) => RelayChild;
    readonly killPid?: (pid: number) => void;
    readonly pidAlive?: (pid: number) => boolean;
    readonly schedule?: (fn: () => void, ms: number) => () => void;
    readonly log?: (line: string) => void;
    /** A child exited (it is started again): whoever drives it stops sending into a child between lives (P3.3b). */
    readonly onChildExit?: (profile: SpawnProfile) => void;
    /**
     * The ptys its children run changed (bug B, VM job 76): every live pty with a known pid, across profiles. The host writes
     * it to disk so the NEXT host can reap what this one leaves if it dies without ending them (main/pty-ledger.ts).
     */
    readonly onPtys?: (ptys: Array<{ profile: SpawnProfile; id: string; pid: number }>) => void;
}

/** How long a lost child's killed helpers are waited for before their ptys are reported exited anyway (#1405's bound). */
export const RELAY_HELPER_GONE_WAIT_MS = 10_000;
/** Restart backoff for a child that died (Genie 1's host-loss recovery). */
export const RELAY_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

export interface SpawnRelay {
    /** A window's frame, to the child of its profile (dropped, said, when that child is between lives). */
    send(profile: string, frame: SpawnFrame): void;
    /** A window's link closed: the processes child ends its streams. */
    windowGone(): void;
    /** Every child asked to end (they end their ptys on disconnect), and gone. */
    stop(): Promise<void>;
    /** How many ptys its children run now: a host with any is not idle. */
    live(): number;
}

const defaultFork = (entry: string, env: Record<string, string>): RelayChild =>
    forkChild(entry, [], { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true }) as unknown as RelayChild;

export function startSpawnRelay(options: SpawnRelayOptions): SpawnRelay {
    const fork = options.fork ?? defaultFork;
    const killPid = options.killPid ?? ((pid: number) => { try { process.kill(pid); } catch { /* already gone */ } });
    const pidAlive = options.pidAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } });
    const schedule = options.schedule ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
    const log = options.log ?? (() => {});
    let stopping = false;

    interface Slot { child: RelayChild | null; ptys: Map<string, number | null>; failures: number }
    const slots = new Map<SpawnProfile, Slot>(SPAWN_PROFILES.map((p) => [p, { child: null, ptys: new Map(), failures: 0 }]));

    const start = (profile: SpawnProfile): void => {
        if (stopping) return;
        const slot = slots.get(profile)!;
        let child: RelayChild;
        try {
            child = fork(options.entry, { GENIE_SPAWN_PROFILE: profile });
        } catch (error) {
            log(`spawn relay: could not start the ${profile} child: ${error instanceof Error ? error.message : String(error)}`);
            restartLater(profile);
            return;
        }
        slot.child = child;
        child.on('message', (message: unknown) => {
            const frame = parseSpawnFrame(message);
            if (!frame) return;
            // What the relay must know to end a dead child's ptys: which are live, and their helpers' pids.
            if (frame.kind === 'event') {
                const payload = (frame.payload ?? {}) as Record<string, unknown>;
                const id = typeof payload['id'] === 'string' ? payload['id'] : null;
                if (id !== null && frame.channel === 'pty.opened') { slot.ptys.set(id, typeof payload['pid'] === 'number' ? payload['pid'] : null); ptysChanged(); }
                if (id !== null && frame.channel === 'pty.exit') { slot.ptys.delete(id); ptysChanged(); }
                if (frame.channel === 'host.ready') {
                    slot.failures = 0;
                    // The same words the window's own spawn host logs when it is ready: "it started" is one line to look for.
                    log(`spawn host ready pid=${child.pid ?? '?'} profile=${profile} (a child of genie-host)`);
                }
            }
            options.send(profile, frame);
        });
        child.on('error', (error: Error) => log(`spawn relay: ${profile} child error: ${error.message}`));
        child.on('exit', (code, signal) => {
            if (slot.child !== child) return;
            slot.child = null;
            if (stopping) return;
            log(`spawn relay: the ${profile} child (pid ${child.pid ?? '?'}) exited (code ${code ?? '?'}${signal ? `, ${signal}` : ''})`);
            const lost = [...slot.ptys];
            slot.ptys.clear();
            ptysChanged();
            options.onChildExit?.(profile);
            for (const [, pid] of lost) if (pid !== null && pid > 0) killPid(pid);
            void reportWhenGone(profile, lost);
            restartLater(profile);
        });
    };

    const ptysChanged = (): void => {
        if (!options.onPtys) return;
        const all: Array<{ profile: SpawnProfile; id: string; pid: number }> = [];
        for (const [profile, slot] of slots) for (const [id, pid] of slot.ptys) if (pid !== null && pid > 0) all.push({ profile, id, pid });
        options.onPtys(all);
    };

    const reportWhenGone = async (profile: SpawnProfile, lost: Array<[string, number | null]>): Promise<void> => {
        const pending = new Set(lost.flatMap(([, pid]) => (pid !== null && pid > 0 ? [pid] : [])));
        const deadline = Date.now() + RELAY_HELPER_GONE_WAIT_MS;
        while (pending.size > 0 && Date.now() < deadline) {
            for (const pid of [...pending]) if (!pidAlive(pid)) pending.delete(pid);
            if (pending.size > 0) await new Promise((r) => setTimeout(r, 100));
        }
        if (pending.size > 0) log(`spawn relay: ${pending.size} pty helper(s) of the ${profile} child still running ${RELAY_HELPER_GONE_WAIT_MS / 1000} s after their kill (${[...pending].join(', ')})`);
        for (const [id] of lost) options.send(profile, { kind: 'event', channel: 'pty.exit', payload: { id, code: -1 } });
    };

    const restartLater = (profile: SpawnProfile): void => {
        const slot = slots.get(profile)!;
        const delay = RELAY_BACKOFF_MS[Math.min(slot.failures, RELAY_BACKOFF_MS.length - 1)]!;
        slot.failures += 1;
        schedule(() => start(profile), delay);
    };

    for (const profile of SPAWN_PROFILES) start(profile);

    return {
        send: (profile, frame) => {
            const slot = slots.get(profile as SpawnProfile);
            if (!slot) { log(`spawn relay: no ${profile} child`); return; }
            if (!slot.child?.connected) { log(`spawn relay: the ${profile} child is between lives; a ${frame.kind === 'call' ? frame.method : frame.kind} was dropped`); return; }
            slot.child.send(frame);
        },
        live: () => [...slots.values()].reduce((n, slot) => n + slot.ptys.size, 0),
        windowGone: () => {
            const child = slots.get('processes')!.child;
            if (child?.connected) child.send({ kind: 'call', id: 0, method: 'spawn.unstreamAll', args: [] });
        },
        stop: async () => {
            stopping = true;
            await Promise.all([...slots.values()].map((slot) => new Promise<void>((resolve) => {
                const child = slot.child;
                if (!child?.connected) { resolve(); return; }
                child.on('exit', () => resolve());
                // `host.shutdown` ends every pty and stream; the child's own disconnect handler then exits it.
                child.send({ kind: 'call', id: 0, method: 'host.shutdown', args: [] });
                setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 3_000).unref?.();
            })));
        },
    };
}
