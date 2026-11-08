import { execFile, fork, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { GitChild, GitExecCallback } from './git-exec.js';
import { randomUUID } from 'node:crypto';
import { parseSpawnFrame, type ListedPty, type SpawnFrame, type SpawnMethod } from './spawn-host-protocol.js';
import { execInProcess, streamInProcess, type LineStream, type RunOptions, type RunResult } from './spawn-exec.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from './terminal-host.js';
import { setExecRoute } from './toolchain-runner.js';
import { terminalPosition, terminalDataPosition } from '../core/terminal-stream.js';
import type { TerminalPosition, TerminalDataPosition } from '../core/terminal-stream.js';

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
 * ENDED — its helper killed by pid (the helper's job object takes the tree with it) — and reported exited (-1) only once
 * that helper is GONE (bounded by HELPER_GONE_WAIT_MS), so the supervisor restarts it in the next child on fresh terms,
 * never racing the dying process for its port (measured on genie-test-windows: reported at once, restarts failed to bind
 * and backed off for 23 s, once past 120 s). The next call
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
    /** Whether a pid still runs (a killed helper is waited for before its pty is reported exited). Default: signal 0. */
    readonly pidAlive?: (pid: number) => boolean;
    /**
     * THE SPAWN HOST OVER A LINK (the host split, P2.1, plan §11a): under genie-host the spawn host is the HOST's child,
     * reached through the engine link. Given, nothing is forked here: frames go out through `link.send` and come in
     * through `linkFrame`; the link's loss (`linkDown`) is not the child's — nothing is killed or reported exited — and
     * `linkUp` reconciles with what is still running.
     */
    readonly link?: { send(frame: SpawnFrame): void };
    /** How long an open waits for a link that has not come up yet. */
    readonly linkWaitMs?: number;
}

/**
 * How long an open waits for a link that has not come up yet (genie#1453). A new host's spawn hosts are ready within about 400 ms; past this it is not coming, and the open
 * is refused in the same words as a link that is down.
 */
export const LINK_WAIT_MS = 10_000;
const NOT_CONNECTED_LINE = '[genie] the agent host is not connected, so this process was not started\r\n';

/** How long a lost child's killed helpers are waited for before their ptys are reported exited anyway. */
export const HELPER_GONE_WAIT_MS = 10_000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/**
 * A git the spawn host created (Tynn #532), as genie-host holds it: its pid (once the host says it), its exit and its
 * codes when it ends, `kill()` and `stdin.end()` sent to the real one. What the read limit and its kill-tree walk use.
 */
class RemoteGitChild extends EventEmitter implements GitChild {
    pid: number | undefined = undefined;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    readonly stdin: { end(input?: string): unknown };
    readonly #send: (method: 'git.kill' | 'git.stdin', args: unknown[]) => void;
    constructor(readonly gitId: string, send: (method: 'git.kill' | 'git.stdin', args: unknown[]) => void) {
        super();
        this.#send = send;
        this.stdin = { end: (input?: string) => { this.#send('git.stdin', [gitId, input ?? '']); return this.stdin; } };
    }
    kill(): boolean {
        if (this.exitCode !== null || this.signalCode !== null) return false;
        this.#send('git.kill', [this.gitId]);
        return true;
    }
}

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
    readonly #gits = new Map<string, { child: RemoteGitChild; callback: GitExecCallback }>();
    readonly #ptys = new Map<string, { pid: number | null; position?: TerminalPosition | null }>();
    readonly #data = new Set<(id: string, data: string, position?: TerminalDataPosition) => void>();
    readonly #exit = new Set<(id: string, code: number, position?: TerminalPosition) => void>();
    readonly #pid = new Set<(id: string, pid: number, shell?: string) => void>();
    readonly #cwd = new Set<(id: string, cwd: string) => void>();
    /** Over a link: whether it is up now (calls and ptys fail, said, while it is not). */
    #linkUp = false;
    /**
     * Where the link stands, for an open. `starting`: it has never been up, and may be about to. `reconciling`: it is up, and the list of what runs is on its way, so an open
     * sent now would be reported gone by that list. Either way an open waits. `down` is a link that went, or never came within the bound: it is refused at once.
     */
    #linkState: 'starting' | 'reconciling' | 'up' | 'down' = 'starting';
    /** Opens waiting for the link, each with what was asked of it meanwhile. */
    readonly #held = new Map<string, { readonly frame: SpawnFrame; readonly after: SpawnFrame[] }>();
    #heldTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: SpawnHostOptions) {
        this.#options = options;
        this.#log = options.log ?? (() => {});
        // Over a link the spawn host is somebody else's child: nothing to fork.
        if (!options.link) this.#start();
    }

    /** The child's pid, or null between children (and always over a link: the child is not this process's). */
    get pid(): number | null {
        return this.#child?.pid ?? null;
    }

    /** A frame from the spawn host, over the link. */
    linkFrame(frame: SpawnFrame): void {
        this.#onFrame(frame);
    }

    /**
     * The link is up (again): the live ptys are listed, every pty this client knew and the host no longer runs is
     * reported exited (-1: the host or its child restarted), and the live ones it did not know are answered — the
     * supervisor's and the terminals' to adopt (`adoptPty`).
     */
    async linkUp(): Promise<ListedPty[]> {
        this.#linkUp = true;
        this.#linkState = 'reconciling';
        this.#sentEnv = null;
        let listed: ListedPty[];
        try {
            listed = (await this.#call('pty.list', [])) as ListedPty[];
        } catch (error) {
            this.#linkState = 'down';
            this.#refuseHeld();
            throw error;
        }
        const live = new Set(listed.map((p) => p.id));
        for (const pty of listed) {
            const entry = this.#ptys.get(pty.id), position = terminalPosition(pty);
            // A reconnect cannot label a stale retained tail with a newer position: it needs a full resync.
            if (entry && (!position || entry.position?.epoch !== position.epoch || entry.position.endOffset !== position.endOffset)) entry.position = null;
        }
        for (const id of [...this.#ptys.keys()]) {
            if (live.has(id)) continue;
            this.#ptys.delete(id);
            for (const l of this.#exit) l(id, -1);
        }
        const answer = listed.filter((p) => !this.#ptys.has(p.id));
        this.#linkState = 'up';
        this.#startHeld();
        return answer;
    }

    /** Hold an open until the link can take it. The bound runs from the first one, and is not extended. */
    #hold(id: string, frame: SpawnFrame): void {
        this.#held.set(id, { frame, after: [] });
        this.#heldTimer ??= setTimeout(() => {
            this.#heldTimer = null;
            if (this.#linkState === 'starting') this.#linkState = 'down';
            this.#refuseHeld();
        }, this.#options.linkWaitMs ?? LINK_WAIT_MS);
        this.#heldTimer.unref?.();
    }

    #stopHeldTimer(): void {
        if (this.#heldTimer) clearTimeout(this.#heldTimer);
        this.#heldTimer = null;
    }

    #startHeld(): void {
        this.#stopHeldTimer();
        for (const [id, held] of [...this.#held]) {
            this.#held.delete(id);
            this.#ptys.set(id, { pid: null });
            this.#send(held.frame);
            for (const frame of held.after) this.#send(frame);
        }
    }

    #refuseHeld(): void {
        this.#stopHeldTimer();
        for (const id of [...this.#held.keys()]) {
            this.#held.delete(id);
            for (const l of this.#data) l(id, NOT_CONNECTED_LINE);
            for (const l of this.#exit) l(id, -1);
        }
    }

    /** The link is down: calls in flight fail (ESPAWNHOST) and streams end; NOTHING is killed — the ptys run on. */
    linkDown(reason: string): void {
        this.#linkUp = false;
        this.#linkState = 'down';
        this.#refuseHeld();
        for (const [, p] of this.#pending) p.reject(Object.assign(new Error(`the spawn host is unreachable: ${reason}`), { code: 'ESPAWNHOST' }));
        this.#pending.clear();
        for (const [, s] of [...this.#streams]) s.onEnd(`the spawn host is unreachable: ${reason}`);
        this.#streams.clear();
        this.#endGits(`the spawn host is unreachable: ${reason}`);
    }

    /** A live pty found by `linkUp`, taken back: its output, exit and writes are routed as for one opened here. */
    adoptPty(pty: ListedPty): void {
        this.#ptys.set(pty.id, { pid: pty.pid > 0 ? pty.pid : null, position: terminalPosition(pty) });
    }

    /** True once the child gave up starting and everything runs in-process. */
    get inProcess(): boolean {
        return this.#fallback;
    }

    exec(binary: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
        if (this.#fallback) return execInProcess(binary, args, options);
        return this.#call('spawn.exec', [binary, [...args], options]) as Promise<RunResult>;
    }

    /** A detached process of Genie's own (the Genie browser), created by the spawn host (Tynn #535): its pid, or null. */
    async spawnDetached(file: string, args: readonly string[], env: Readonly<Record<string, string>>, logFile: string): Promise<number | null> {
        const value = await this.#call('spawn.detached', [file, [...args], { ...env }, logFile]) as { pid?: unknown } | null;
        return typeof value?.pid === 'number' && value.pid > 0 ? value.pid : null;
    }

    /**
     * `execFile`, created by the spawn host (Tynn #532): genie-host's git, through git-exec.ts. Answered at once with the
     * child as genie-host holds it; its callback and exit come when the real git ends.
     */
    gitExec = (file: string, args: readonly string[], options: ExecFileOptions, callback: GitExecCallback): GitChild => {
        if (this.#fallback) return execFile(file, [...args], options, callback);
        const gitId = `git_${randomUUID()}`;
        const child = new RemoteGitChild(gitId, (method, a) => this.#send({ kind: 'call', id: 0, method, args: a }));
        this.#gits.set(gitId, { child, callback });
        const wire = {
            ...(typeof options.cwd === 'string' ? { cwd: options.cwd } : {}),
            ...(typeof options.maxBuffer === 'number' ? { maxBuffer: options.maxBuffer } : {}),
            ...(typeof options.timeout === 'number' ? { timeout: options.timeout } : {}),
            ...(options.env ? { env: options.env } : {}),
        };
        this.#call('git.exec', [gitId, file, [...args], wire]).then(
            (value) => { const pid = (value as { pid?: unknown } | null)?.pid; if (typeof pid === 'number' && pid > 0) child.pid = pid; },
            (error: unknown) => this.#gitEnded(gitId, { error: { message: error instanceof Error ? error.message : String(error), code: (error as { code?: unknown })?.code ?? 'ESPAWNHOST' }, stdout: '', stderr: '', exitCode: null, signalCode: null }),
        );
        return child;
    };

    #gitEnded(gitId: string, payload: Record<string, unknown>): void {
        const entry = this.#gits.get(gitId);
        if (!entry) return;
        this.#gits.delete(gitId);
        const raw = payload['error'] as { message?: unknown; code?: unknown; killed?: unknown; signal?: unknown } | null | undefined;
        const error = raw ? Object.assign(new Error(typeof raw.message === 'string' ? raw.message : 'git failed'), {
            ...(raw.code !== undefined ? { code: raw.code } : {}), ...(typeof raw.killed === 'boolean' ? { killed: raw.killed } : {}), ...(typeof raw.signal === 'string' ? { signal: raw.signal } : {}),
        }) : null;
        const exitCode = typeof payload['exitCode'] === 'number' ? payload['exitCode'] : null;
        const signalCode = typeof payload['signalCode'] === 'string' ? payload['signalCode'] as NodeJS.Signals : null;
        // Ended either way: a git with no code of its own (the host lost) is ended, -1.
        entry.child.exitCode = exitCode ?? (signalCode === null ? -1 : null);
        entry.child.signalCode = signalCode;
        entry.child.emit('exit', entry.child.exitCode, signalCode);
        entry.callback(error, String(payload['stdout'] ?? ''), String(payload['stderr'] ?? ''));
    }

    #endGits(why: string): void {
        for (const gitId of [...this.#gits.keys()]) this.#gitEnded(gitId, { error: { message: why, code: 'ESPAWNHOST' }, stdout: '', stderr: '', exitCode: null, signalCode: null });
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
            fallback.onData((id, data, position) => { if (fallbackOwned.has(id)) for (const l of this.#data) { if (position) l(id, data, position); else l(id, data); } });
            fallback.onExit((id, code, position) => { if (fallbackOwned.delete(id)) for (const l of this.#exit) { if (position) l(id, code, position); else l(id, code); } });
        }
        return {
            open: (spawn: PtySpawnOptions): PtyOpened => {
                if (this.#fallback && fallback) {
                    const opened = fallback.open(spawn);
                    fallbackOwned.add(opened.id);
                    return opened;
                }
                // The caller's id when it gave one (a window's replica, P3.3e), never one already in use.
                const id = spawn.id && !this.#ptys.has(spawn.id) ? spawn.id : `term_${randomUUID()}`;
                const { tag, id: _asked, ...engineSpawn } = spawn;
                void _asked;
                // The tag is the spawn host's to keep, not the engine's: it travels beside the spawn options.
                const openFrame: SpawnFrame = { kind: 'call', id: 0, method: 'pty.open', args: [id, engineSpawn, tag ?? null] };
                if (this.#options.link && (this.#linkState === 'starting' || this.#linkState === 'reconciling')) {
                    this.#hold(id, openFrame);
                    return { id, pid: 0, shell: spawn.command ?? '', scrollback: '' };
                }
                if (this.#options.link && !this.#linkUp) {
                    // Over a link that is down: not started, and said (a crash with words, never a silent hang).
                    queueMicrotask(() => {
                        for (const l of this.#data) l(id, NOT_CONNECTED_LINE);
                        for (const l of this.#exit) l(id, -1);
                    });
                    return { id, pid: 0, shell: spawn.command ?? '', scrollback: '' };
                }
                if (this.#fallback) {
                    // No child and no engine to fall back on: the process cannot start, and says so (a crash with words).
                    queueMicrotask(() => {
                        for (const l of this.#data) l(id, '[genie] the spawn host could not start, so this process was not started\r\n');
                        for (const l of this.#exit) l(id, -1);
                    });
                    return { id, pid: 0, shell: spawn.command ?? '', scrollback: '' };
                }
                this.#ptys.set(id, { pid: null });
                this.#send(openFrame);
                return { id, pid: 0, shell: spawn.command ?? '', scrollback: '' };
            },
            write: (id, data) => {
                if (fallbackOwned.has(id)) return fallback!.write(id, data);
                const waitingW = this.#held.get(id);
                if (waitingW) { waitingW.after.push({ kind: 'call', id: 0, method: 'pty.write', args: [id, data] }); return true; }
                if (!this.#ptys.has(id)) return false;
                this.#send({ kind: 'call', id: 0, method: 'pty.write', args: [id, data] });
                return true;
            },
            resize: (id, cols, rows) => {
                if (fallbackOwned.has(id)) return fallback!.resize(id, cols, rows);
                const waitingR = this.#held.get(id);
                if (waitingR) { waitingR.after.push({ kind: 'call', id: 0, method: 'pty.resize', args: [id, cols, rows] }); return true; }
                if (!this.#ptys.has(id)) return false;
                this.#send({ kind: 'call', id: 0, method: 'pty.resize', args: [id, cols, rows] });
                return true;
            },
            kill: (id) => {
                if (fallbackOwned.delete(id)) return fallback!.kill(id);
                // Never started: nothing to kill, and it ends the way a killed one does.
                if (this.#held.delete(id)) { queueMicrotask(() => { for (const l of this.#exit) l(id, -1); }); return true; }
                if (!this.#ptys.delete(id)) return false;
                this.#send({ kind: 'call', id: 0, method: 'pty.kill', args: [id] });
                return true;
            },
            // The supervisor keeps its own log of what a process printed (OutputTail); nothing is held twice here.
            scrollback: (id) => (fallbackOwned.has(id) ? fallback!.scrollback(id) : undefined),
            position: (id) => fallbackOwned.has(id) ? fallback!.position?.(id) ?? null : this.#ptys.get(id)?.position ?? null,
            isLive: (id) => (fallbackOwned.has(id) ? fallback!.isLive?.(id) ?? true : this.#ptys.has(id) || this.#held.has(id)),
            onData: (l) => { this.#data.add(l); return () => this.#data.delete(l); },
            onExit: (l) => { this.#exit.add(l); return () => this.#exit.delete(l); },
            onPid: (l) => { this.#pid.add(l); return () => this.#pid.delete(l); },
            onCwd: (l) => { this.#cwd.add(l); return () => this.#cwd.delete(l); },
        };
    }

    /** Every pty and stream ended, the child asked to exit, and gone (forced after `ms`). */
    async stop(ms = 3_000): Promise<void> {
        this.#stopping = true;
        // Over a link the child is the host's: the host ends it ("Shut down everything"), never a window.
        if (this.#options.link) return;
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
        this.#endGits(`the spawn host ${why}`);
        const killPid = this.#options.killPid ?? ((pid: number) => { try { process.kill(pid); } catch { /* already gone */ } });
        const pidAlive = this.#options.pidAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } });
        const lost = [...this.#ptys].map(([id, p]) => ({ id, pid: p.pid }));
        for (const { pid } of lost) if (pid !== null && pid > 0) killPid(pid);
        // Still live to the supervisor while they die: reported exited once each helper is gone, then restarted.
        void (async () => {
            const deadline = Date.now() + HELPER_GONE_WAIT_MS;
            const pending = new Set(lost.filter((l) => l.pid !== null && l.pid > 0).map((l) => l.pid!));
            while (pending.size > 0 && Date.now() < deadline) {
                for (const pid of [...pending]) if (!pidAlive(pid)) pending.delete(pid);
                if (pending.size > 0) await new Promise((r) => setTimeout(r, 100));
            }
            if (pending.size > 0) this.#log(`spawn host ${child.pid ?? '?'}: ${pending.size} pty helper(s) still running ${HELPER_GONE_WAIT_MS / 1000} s after their kill (${[...pending].join(', ')})`);
            for (const { id } of lost) {
                // A pty the supervisor stopped meanwhile was forgotten here already: nothing to report.
                if (!this.#ptys.delete(id)) continue;
                for (const l of this.#exit) l(id, -1);
            }
        })();
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
                entry.position = terminalPosition(payload);
                const shell = typeof payload['shell'] === 'string' && payload['shell'] !== '' ? payload['shell'] : undefined;
                for (const l of this.#pid) l(id, pid, shell);
                return;
            }
            case 'pty.data': {
                const entry = this.#ptys.get(id);
                if (!entry) return;
                const data = String(payload['data'] ?? ''), position = terminalDataPosition(payload, data), held = entry.position;
                entry.position = position && ((held === undefined && position.offset === 0) || (held?.epoch === position.epoch && held.endOffset === position.offset))
                    ? { epoch: position.epoch, endOffset: position.endOffset } : null;
                for (const l of this.#data) { if (position) l(id, data, position); else l(id, data); }
                return;
            }
            case 'pty.cwd':
                if (this.#ptys.has(id)) for (const l of this.#cwd) l(id, String(payload['cwd'] ?? ''));
                return;
            case 'pty.exit': {
                if (!this.#ptys.delete(id)) return;
                const position = terminalPosition(payload), code = typeof payload['code'] === 'number' ? payload['code'] : -1;
                for (const l of this.#exit) { if (position) l(id, code, position); else l(id, code); }
                return;
            }
            case 'git.exit':
                this.#gitEnded(id, payload);
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
        if (this.#options.link) {
            if (!this.#linkUp) return Promise.reject(Object.assign(new Error('the agent host is not connected'), { code: 'ESPAWNHOST' }));
            this.#seq += 1;
            const id = this.#seq;
            return new Promise((resolve, reject) => {
                this.#pending.set(id, { resolve, reject });
                this.#send({ kind: 'call', id, method, args });
            });
        }
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
        const link = this.#options.link;
        if (link) {
            if (!this.#linkUp) return;
            if (frame.kind === 'call' && frame.method !== 'host.env') {
                const env = mainEnv();
                const text = JSON.stringify(env);
                if (text !== this.#sentEnv) {
                    this.#sentEnv = text;
                    link.send({ kind: 'call', id: 0, method: 'host.env', args: [env] });
                }
            }
            link.send(frame);
            return;
        }
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
