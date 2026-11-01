import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseSpawnFrame, type SpawnFrame, type SpawnMethod } from './spawn-host-protocol.js';
import { execInProcess, streamInProcess, type LineStream, type RunOptions, type RunResult } from './spawn-exec.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from './terminal-host.js';
import { setExecRoute } from './toolchain-runner.js';

/**
 * MAIN'S SIDE OF THE SPAWN HOST (genie#1397). The owner's beta.54 lifecycle.log: main held 600 s in 216 blocks (up to
 * 18.3 s; 9.7 s at boot) creating Docker CLI processes, and 20 s more creating supervised ptys — Windows creates a
 * process synchronously on the calling thread. So main creates none: it forks ONE long-lived child at boot, the spawn
 * host (main/spawn-host.ts, Genie's own executable as Node), and asks it over messages.
 *
 * - `exec` is `execFileRunner` (routed here by {@link routeExecThroughSpawnHost}), the same result and error codes.
 * - `stream` is a long-lived process's lines (`docker events`).
 * - `ptyPort()` is a PtyPort for the supervisor. `open` answers at once with main's own id and pid 0 (not known yet);
 *   the pid arrives as `onPid`, output and the exit as they happen.
 *
 * WHEN THE CHILD IS GONE: every call in flight fails with code ESPAWNHOST, every stream ends, and every pty it held is
 * ENDED — its helper killed by pid (the helper's job object takes the tree with it), then reported exited (-1), so the
 * supervisor restarts it in the next child on fresh terms instead of beside an orphan holding its port. The next call
 * forks a new child. A child that cannot start ({@link MAX_FAILED_STARTS} in a row exit before they are ready) is given
 * up on for this session: calls run in-process (the fallback) and ptys go to the fallback port, said once in the log.
 *
 * The child is forked with an IPC channel and dies with Genie: it exits on `disconnect`, which a crashed main causes too.
 */

export const MAX_FAILED_STARTS = 3;

export interface SpawnHostOptions {
    /** The child's entry script (dist/main/spawn-host.js; a test's fixture). */
    readonly entry: string;
    /** The runtime to run it with: Genie's own executable (as Node, ELECTRON_RUN_AS_NODE) in the app; node in tests. */
    readonly execPath?: string;
    readonly execArgv?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    /** Lifecycle lines: the child's start, its loss, the fallback. */
    readonly log?: (line: string) => void;
    /** Kill a pty's helper by pid when the child that held it is gone. Default: process.kill. */
    readonly killPid?: (pid: number) => void;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class SpawnHostClient {
    readonly #options: SpawnHostOptions;
    readonly #log: (line: string) => void;
    #child: ChildProcess | null = null;
    #ready = false;
    #failedStarts = 0;
    #fallback = false;
    #stopping = false;
    #seq = 0;
    /** The environment last made the child's (canonical JSON), so it is sent again only when main's changed. */
    #sentEnv: string | null = null;
    readonly #pending = new Map<number, Pending>();
    readonly #streams = new Map<string, { onLine: (line: string) => void; onEnd: (reason: string) => void }>();
    readonly #ptys = new Map<string, { pid: number | null }>();
    readonly #data = new Set<(id: string, data: string) => void>();
    readonly #exit = new Set<(id: string, code: number) => void>();
    readonly #pid = new Set<(id: string, pid: number) => void>();

    constructor(options: SpawnHostOptions) {
        this.#options = options;
        this.#log = options.log ?? (() => {});
        this.#start();
    }

    /** The child's pid, or null between children. */
    get pid(): number | null {
        return this.#child?.pid ?? null;
    }

    /** True once the child gave up starting and everything runs in-process. */
    get inProcess(): boolean {
        return this.#fallback;
    }

    exec(binary: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
        if (this.#fallback) return execInProcess(binary, args, options);
        return this.#call('spawn.exec', [binary, [...args], options]) as Promise<RunResult>;
    }

    stream: LineStream = (binary, args, onLine, onEnd) => {
        if (this.#fallback) return streamInProcess(binary, args, onLine, onEnd);
        const id = `stream_${randomUUID()}`;
        this.#streams.set(id, { onLine, onEnd });
        this.#call('spawn.stream', [id, binary, [...args]]).catch(() => { /* its end says why */ });
        return {
            stop: () => {
                if (!this.#streams.delete(id)) return;
                this.#send({ kind: 'call', id: 0, method: 'spawn.unstream', args: [id] });
            },
        };
    };

    /** The supervisor's pty engine. `fallback` takes new ptys when the child cannot start (main's in-process engine). */
    ptyPort(fallback?: PtyPort): PtyPort {
        const fallbackOwned = new Set<string>();
        if (fallback) {
            fallback.onData((id, data) => { if (fallbackOwned.has(id)) for (const l of this.#data) l(id, data); });
            fallback.onExit((id, code) => { if (fallbackOwned.delete(id)) for (const l of this.#exit) l(id, code); });
        }
        return {
            open: (spawn: PtySpawnOptions): PtyOpened => {
                if (this.#fallback && fallback) {
                    const opened = fallback.open(spawn);
                    fallbackOwned.add(opened.id);
                    return opened;
                }
                const id = `term_${randomUUID()}`;
                if (this.#fallback) {
                    // No child and no engine to fall back on: the process cannot start, and says so (a crash with words).
                    queueMicrotask(() => {
                        for (const l of this.#data) l(id, '[genie] the spawn host could not start, so this process was not started\r\n');
                        for (const l of this.#exit) l(id, -1);
                    });
                    return { id, pid: 0, shell: spawn.command ?? '', scrollback: '' };
                }
                this.#ptys.set(id, { pid: null });
                this.#send({ kind: 'call', id: 0, method: 'pty.open', args: [id, spawn] });
                return { id, pid: 0, shell: spawn.command ?? '', scrollback: '' };
            },
            write: (id, data) => {
                if (fallbackOwned.has(id)) return fallback!.write(id, data);
                if (!this.#ptys.has(id)) return false;
                this.#send({ kind: 'call', id: 0, method: 'pty.write', args: [id, data] });
                return true;
            },
            resize: (id, cols, rows) => {
                if (fallbackOwned.has(id)) return fallback!.resize(id, cols, rows);
                if (!this.#ptys.has(id)) return false;
                this.#send({ kind: 'call', id: 0, method: 'pty.resize', args: [id, cols, rows] });
                return true;
            },
            kill: (id) => {
                if (fallbackOwned.delete(id)) return fallback!.kill(id);
                if (!this.#ptys.delete(id)) return false;
                this.#send({ kind: 'call', id: 0, method: 'pty.kill', args: [id] });
                return true;
            },
            // The supervisor keeps its own log of what a process printed (OutputTail); nothing is held twice here.
            scrollback: (id) => (fallbackOwned.has(id) ? fallback!.scrollback(id) : undefined),
            isLive: (id) => (fallbackOwned.has(id) ? fallback!.isLive?.(id) ?? true : this.#ptys.has(id)),
            onData: (l) => { this.#data.add(l); return () => this.#data.delete(l); },
            onExit: (l) => { this.#exit.add(l); return () => this.#exit.delete(l); },
            onPid: (l) => { this.#pid.add(l); return () => this.#pid.delete(l); },
        };
    }

    /** Every pty and stream ended, the child asked to exit, and gone (forced after `ms`). */
    async stop(ms = 3_000): Promise<void> {
        this.#stopping = true;
        const child = this.#child;
        if (!child || child.exitCode !== null) return;
        const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        this.#call('host.shutdown', []).catch(() => {});
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, ms);
        await gone;
        clearTimeout(timer);
    }

    #start(): void {
        if (this.#stopping || this.#fallback) return;
        let child: ChildProcess;
        try {
            child = fork(this.#options.entry, [], {
                ...(this.#options.execPath ? { execPath: this.#options.execPath } : {}),
                execArgv: [...(this.#options.execArgv ?? [])],
                env: { ...process.env, ...this.#options.env, ELECTRON_RUN_AS_NODE: '1' },
                stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
                windowsHide: true,
            });
        } catch (error) {
            this.#startFailed(error instanceof Error ? error.message : String(error));
            return;
        }
        this.#child = child;
        this.#ready = false;
        this.#sentEnv = null;
        child.on('message', (m: unknown) => {
            const frame = parseSpawnFrame(m);
            if (frame) this.#onFrame(frame);
        });
        child.on('error', (error) => this.#log(`spawn host error: ${error.message}`));
        child.once('exit', (code, signal) => this.#onGone(child, `exited (code ${code ?? '?'}${signal ? `, ${signal}` : ''})`));
    }

    #startFailed(reason: string): void {
        this.#failedStarts += 1;
        if (this.#failedStarts >= MAX_FAILED_STARTS) {
            this.#fallback = true;
            this.#log(`spawn host could not start ${this.#failedStarts} times (${reason}); processes are created in-process on main for this session`);
        }
    }

    #onGone(child: ChildProcess, why: string): void {
        if (this.#child !== child) return;
        this.#child = null;
        const wasReady = this.#ready;
        this.#ready = false;
        if (!this.#stopping) this.#log(`spawn host ${child.pid ?? '?'} ${why}${wasReady ? '' : ' before it was ready'}`);
        for (const [, p] of this.#pending) p.reject(Object.assign(new Error(`the spawn host ${why}`), { code: 'ESPAWNHOST' }));
        this.#pending.clear();
        for (const [, s] of [...this.#streams]) s.onEnd(`the spawn host ${why}`);
        this.#streams.clear();
        const killPid = this.#options.killPid ?? ((pid: number) => { try { process.kill(pid); } catch { /* already gone */ } });
        for (const [id, p] of [...this.#ptys]) {
            this.#ptys.delete(id);
            if (p.pid !== null && p.pid > 0) killPid(p.pid);
            for (const l of this.#exit) l(id, -1);
        }
        if (this.#stopping) return;
        if (!wasReady) this.#startFailed(why);
        else this.#failedStarts = 0;
        // Ready for the next call: a new child now (its ptys come back through the supervisor's restarts).
        this.#start();
    }

    #onFrame(frame: SpawnFrame): void {
        if (frame.kind === 'result') {
            const p = this.#pending.get(frame.id);
            if (!p) return;
            this.#pending.delete(frame.id);
            if (frame.ok) p.resolve(frame.value);
            else p.reject(Object.assign(new Error(frame.reason), frame.code ? { code: frame.code } : {}));
            return;
        }
        if (frame.kind !== 'event') return;
        const payload = (frame.payload ?? {}) as Record<string, unknown>;
        const id = typeof payload['id'] === 'string' ? payload['id'] : '';
        switch (frame.channel) {
            case 'host.ready':
                this.#ready = true;
                this.#failedStarts = 0;
                this.#log(`spawn host ready pid=${this.#child?.pid ?? '?'}`);
                return;
            case 'pty.opened': {
                const entry = this.#ptys.get(id);
                const pid = typeof payload['pid'] === 'number' ? payload['pid'] : 0;
                if (!entry || !(pid > 0)) return;
                entry.pid = pid;
                for (const l of this.#pid) l(id, pid);
                return;
            }
            case 'pty.data':
                if (this.#ptys.has(id)) for (const l of this.#data) l(id, String(payload['data'] ?? ''));
                return;
            case 'pty.exit':
                if (!this.#ptys.delete(id)) return;
                for (const l of this.#exit) l(id, typeof payload['code'] === 'number' ? payload['code'] : -1);
                return;
            case 'stream.line':
                this.#streams.get(id)?.onLine(String(payload['line'] ?? ''));
                return;
            case 'stream.end': {
                const s = this.#streams.get(id);
                this.#streams.delete(id);
                s?.onEnd(String(payload['reason'] ?? 'ended'));
                return;
            }
        }
    }

    #call(method: SpawnMethod, args: unknown[]): Promise<unknown> {
        if (!this.#child) this.#start();
        const child = this.#child;
        if (!child) return Promise.reject(Object.assign(new Error('the spawn host is not running'), { code: 'ESPAWNHOST' }));
        this.#seq += 1;
        const id = this.#seq;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#send({ kind: 'call', id, method, args });
        });
    }

    #send(frame: SpawnFrame): void {
        if (!this.#child) this.#start();
        const child = this.#child;
        if (!child?.connected) return;
        // Main's environment NOW, before anything is started with it (only when it changed since it was last sent).
        if (frame.kind === 'call' && frame.method !== 'host.env') {
            const env = mainEnv();
            const text = JSON.stringify(env);
            if (text !== this.#sentEnv) {
                this.#sentEnv = text;
                child.send({ kind: 'call', id: 0, method: 'host.env', args: [env] } satisfies SpawnFrame);
            }
        }
        child.send(frame);
    }
}

/** Main's own environment as the child should have it: everything but the fork's runtime switch. */
function mainEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && k.toUpperCase() !== 'ELECTRON_RUN_AS_NODE') out[k] = v;
    return out;
}

export function startSpawnHost(options: SpawnHostOptions): SpawnHostClient {
    return new SpawnHostClient(options);
}

/** `execFileRunner` and the line streams go through `client` from now on; `null` puts them back in-process. */
export function routeExecThroughSpawnHost(client: SpawnHostClient | null): void {
    setExecRoute(client ? { exec: (b, a, o) => client.exec(b, a, o), stream: client.stream } : null);
}
