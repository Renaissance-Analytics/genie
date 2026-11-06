import type { PtyPort, PtySpawnOptions } from './terminal-host.js';
import type { ListedPty, PtyTag, SpawnChannel, SpawnFrame } from './spawn-host-protocol.js';
import type { LineStream, RunOptions, RunResult } from './spawn-exec.js';
import { randomUUID } from 'node:crypto';
import { SPAWN_PROTOCOL } from './spawn-host-protocol.js';
import { splitTerminalText, TerminalOutputCounter } from '../core/terminal-stream.js';

/**
 * THE SPAWN HOST'S SIDE OF THE WIRE (genie#1397): what the child does with main's calls. Pure over its ports, so the
 * tests drive it over an in-memory channel and a fixture child serves it with a deliberately slow spawner.
 *
 * - `spawn.exec [binary, args, options]` → the command's result, or its error with the error's code.
 * - `spawn.stream [streamId, binary, args]` → `stream.line {id, line}` per stdout line, `stream.end {id, reason}` once.
 * - `pty.open [id, spawn]` → `pty.opened {id, pid}`, then `pty.data {id, data}` and one `pty.exit {id, code}`. The id is
 *   MAIN's (it answers the supervisor synchronously); the engine's own id stays here. A pty that cannot be started says
 *   why in its output and exits -1, which the supervisor reads as a crash, with the words in the process's log.
 * - `pty.write` / `pty.resize` / `pty.kill` act on main's id. `host.shutdown` kills every pty and stream, then answers.
 * - `pty.open`'s third argument is the pty's TAG (what it is to the window); `pty.list` answers every live pty with its
 *   id, pid, tag and scrollback, so a window that restarted takes them back (the host split, P2.1).
 */

export interface SpawnHostImpl {
    readonly exec: (binary: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;
    readonly stream: LineStream;
    /** The pty engine for supervised processes; `null` = this host makes no ptys. */
    readonly pty: PtyPort | null;
}

/**
 * Main's environment, made this process's, whole: every key main does not have is removed (Windows' names are matched
 * without case, as Windows does), every key it has is set. What the next exec and pty inherit.
 */
export function adoptEnv(next: unknown, env: NodeJS.ProcessEnv = process.env): void {
    if (typeof next !== 'object' || next === null) return;
    const wanted = Object.entries(next as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string');
    const keep = new Set(wanted.map(([k]) => (process.platform === 'win32' ? k.toUpperCase() : k)));
    for (const k of Object.keys(env)) if (!keep.has(process.platform === 'win32' ? k.toUpperCase() : k)) delete env[k];
    for (const [k, v] of wanted) env[k] = v;
}

export function serveSpawnHost(channel: SpawnChannel, impl: SpawnHostImpl): { killAll(): void } {
    const ptys = new Map<string, string>(); // main's id → the engine's
    const known = new Map<string, { pid: number; shell: string; tag: PtyTag | null; counter: TerminalOutputCounter }>();
    let opening: { id: string; counter: TerminalOutputCounter; ended: boolean } | null = null;
    const byEngine = new Map<string, string>(); // the engine's id → main's
    const streams = new Map<string, { stop(): void }>();
    const event = (ch: Extract<SpawnFrame, { kind: 'event' }>['channel'], payload: unknown) => channel.send({ kind: 'event', channel: ch, payload });
    const answer = (id: number, value: unknown) => { if (id > 0) channel.send({ kind: 'result', id, ok: true, value }); };
    const refuse = (id: number, error: unknown) => {
        if (id <= 0) return;
        const code = (error as { code?: unknown } | null)?.code;
        channel.send({ kind: 'result', id, ok: false, reason: error instanceof Error ? error.message : String(error), ...(typeof code === 'string' ? { code } : {}) });
    };

    const output = (id: string, counter: TerminalOutputCounter, data: string) => {
        const position = counter.append(data);
        for (const chunk of splitTerminalText(data, position.offset)) event('pty.data', { id, epoch: position.epoch, offset: chunk.offset, endOffset: chunk.offset + chunk.data.length, data: chunk.data });
    };
    impl.pty?.onData((engineId, data) => {
        const id = byEngine.get(engineId), current = id === undefined ? opening : null;
        const counter = id === undefined ? current?.counter : known.get(id)?.counter;
        if (counter && !current?.ended) output(id ?? current!.id, counter, data);
    });
    // An interactive terminal's cwd (the `terminals` profile hooks OSC-7; the supervised `processes` one does not).
    impl.pty?.onCwd?.((engineId, cwd) => {
        const id = byEngine.get(engineId);
        if (id !== undefined) event('pty.cwd', { id, cwd });
    });
    impl.pty?.onExit((engineId, code) => {
        const id = byEngine.get(engineId);
        if (id === undefined) {
            if (opening && !opening.ended) { opening.ended = true; event('pty.exit', { id: opening.id, code, ...opening.counter.snapshot() }); }
            return;
        }
        const position = known.get(id)?.counter.snapshot();
        byEngine.delete(engineId);
        ptys.delete(id);
        known.delete(id);
        event('pty.exit', { id, code, ...position });
    });

    const killAll = () => {
        for (const [id, engineId] of [...ptys]) {
            ptys.delete(id);
            known.delete(id);
            byEngine.delete(engineId);
            try { impl.pty?.kill(engineId); } catch { /* already gone */ }
        }
        for (const [id, s] of [...streams]) { streams.delete(id); s.stop(); }
    };

    channel.onFrame((frame) => {
        if (frame.kind !== 'call') return;
        const { id, method, args } = frame;
        switch (method) {
            case 'host.env': {
                adoptEnv(args[0]);
                answer(id, true);
                return;
            }
            case 'spawn.exec': {
                const [binary, argv, options] = args as [string, string[], RunOptions | undefined];
                impl.exec(binary, argv, options ?? {}).then((r) => answer(id, r), (error: unknown) => refuse(id, error));
                return;
            }
            case 'spawn.stream': {
                const [streamId, binary, argv] = args as [string, string, string[]];
                try {
                    const s = impl.stream(binary, argv, (line) => event('stream.line', { id: streamId, line }), (reason) => { streams.delete(streamId); event('stream.end', { id: streamId, reason }); });
                    streams.set(streamId, s);
                    answer(id, true);
                } catch (error) {
                    event('stream.end', { id: streamId, reason: error instanceof Error ? error.message : String(error) });
                    refuse(id, error);
                }
                return;
            }
            case 'spawn.unstreamAll': {
                // The window that asked for them is gone (genie-host says so when its link drops): their lines go nowhere.
                for (const [sid, s] of [...streams]) { streams.delete(sid); s.stop(); }
                answer(id, true);
                return;
            }
            case 'spawn.unstream': {
                const s = streams.get(args[0] as string);
                streams.delete(args[0] as string);
                s?.stop();
                answer(id, true);
                return;
            }
            case 'pty.open': {
                const [ptyId, spawn, tag] = args as [string, PtySpawnOptions, PtyTag | undefined];
                const counter = new TerminalOutputCounter(randomUUID());
                if (!impl.pty) {
                    output(ptyId, counter, '[genie] the spawn host makes no ptys\r\n');
                    event('pty.exit', { id: ptyId, code: -1, ...counter.snapshot() });
                    return;
                }
                const previous = opening, current = { id: ptyId, counter, ended: false };
                opening = current; // Even a synchronous first byte belongs to this producer epoch.
                try {
                    const opened = impl.pty.open(spawn);
                    if (current.ended) return;
                    ptys.set(ptyId, opened.id);
                    byEngine.set(opened.id, ptyId);
                    known.set(ptyId, { pid: opened.pid, shell: opened.shell, tag: tag ?? null, counter });
                    // The SHELL it resolved, with the pid: the window's open answered before either existed.
                    event('pty.opened', { id: ptyId, pid: opened.pid, shell: opened.shell, ...counter.snapshot() });
                } catch (error) {
                    if (!current.ended) {
                        output(ptyId, counter, `[genie] could not start ${spawn.command ?? 'the process'}: ${error instanceof Error ? error.message : String(error)}\r\n`);
                        event('pty.exit', { id: ptyId, code: -1, ...counter.snapshot() });
                    }
                } finally { opening = previous; }
                return;
            }
            case 'pty.write': {
                const engineId = ptys.get(args[0] as string);
                if (engineId !== undefined) impl.pty?.write(engineId, args[1] as string);
                return;
            }
            case 'pty.resize': {
                const engineId = ptys.get(args[0] as string);
                if (engineId !== undefined) impl.pty?.resize(engineId, args[1] as number, args[2] as number);
                return;
            }
            case 'pty.kill': {
                const ptyId = args[0] as string;
                const engineId = ptys.get(ptyId);
                if (engineId === undefined) return;
                // Killed on main's word: main already forgot it, so its exit is not reported back.
                ptys.delete(ptyId);
                known.delete(ptyId);
                byEngine.delete(engineId);
                impl.pty?.kill(engineId);
                return;
            }
            case 'pty.list': {
                const listed: ListedPty[] = [...ptys].map(([ptyId, engineId]) => ({
                    id: ptyId,
                    pid: known.get(ptyId)?.pid ?? 0,
                    tag: known.get(ptyId)?.tag ?? null,
                    shell: known.get(ptyId)?.shell ?? '',
                    scrollback: impl.pty?.scrollback(engineId) ?? '',
                    ...known.get(ptyId)?.counter.snapshot(),
                }));
                answer(id, listed);
                return;
            }
            case 'host.shutdown': {
                killAll();
                answer(id, true);
                return;
            }
        }
    });
    event('host.ready', { pid: process.pid, protocol: SPAWN_PROTOCOL });
    return { killAll };
}
