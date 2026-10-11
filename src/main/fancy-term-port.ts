import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
    configureInProcessBackend,
    createSnapshotStore,
    inProcessBackend,
    parseCommandLine,
    resolveDefaultShell,
} from '@particle-academy/fancy-term-host';
import type { PtyOpened, PtyPort, PtySpawnOptions } from './terminal-host.js';

/**
 * `fancy-term-host` behind Genie's `PtyPort`.
 *
 * The engine is Fancy's and does the real work — node-pty, bounded scrollback, snapshot and
 * replay, retained ptys, the OSC-7 cwd hook. This file is the mapping onto the four verbs and
 * two subscriptions `TerminalHost` asks for, and nothing more: the port is deliberately smaller
 * than the engine's `PtyBackend`, so that Genie cannot drift into reimplementing what the
 * package owns.
 *
 * ## The one rule holds here too
 *
 * Nothing in this file can name an agent. `PtySpawnOptions` is a cwd, an optional command and
 * a size; `TerminalHost` adds a workspace. There is no path from an `AgentId` to this spawn,
 * and `test/no-agent-pty.test.ts` counts that at the host.
 *
 * ## Dependency shape, decided by the owner 2026-10-10
 *
 * `node-pty` is `fancy-term-host`'s declared peer and `@xterm/*` are `fancy-term`'s. They are
 * NOT declared in genie2's `package.json` — npm installs peers on its own — and the manifest
 * stays Fancy and Prism only. Fancy bounded the xterm ranges (`<6`, `<0.11`) in `fancy-term@0.6.1`
 * so a new major can no longer resolve silently; `fancy-term-host`'s `node-pty: ^1.0.0` was
 * already bounded. The `/ipc` subpath exists for a process that must ship with no native
 * dependency, which genie2 — one npm tree — does not have.
 */

/** The slice of `PtyBackend` this adapter uses. Injected so the mapping is testable without a pty. */
export interface HostBackend {
    create(opts: {
        id: string;
        cwd: string;
        shell?: string;
        args?: string[];
        cols?: number;
        rows?: number;
        /** Extra env overrides, merged on top of the engine's process.env. */
        env?: Record<string, string>;
    }): { id: string; pid: number; shell: string; existing: boolean; scrollback: string };
    write(id: string, data: string): boolean;
    resize(id: string, cols: number, rows: number): boolean;
    kill(id: string): boolean;
    getScrollback(id: string): string | undefined;
    on(event: 'data', listener: (id: string, data: string) => void): unknown;
    on(event: 'exit', listener: (id: string, payload: { exitCode: number; signal?: number }) => void): unknown;
}

export interface FancyTermPortOptions {
    /** The user's login shell, when a terminal names no command. The engine resolves it. */
    defaultShell: () => { command: string; args: string[] };
}

export function fancyTermPort(backend: HostBackend, options: FancyTermPortOptions): PtyPort {
    /*
     * One subscription on the engine, fanned out to however many listeners the host has.
     *
     * `PtyBackend.on` is an EventEmitter with no `off` in the port's contract, so subscribing
     * per listener would leak one engine listener per closed window — the previous build's
     * exact leak. Subscribe once, keep our own set, hand back real unsubscribes.
     */
    const dataListeners = new Set<(id: string, data: string) => void>();
    const exitListeners = new Set<(id: string, exitCode: number) => void>();
    backend.on('data', (id, data) => {
        for (const l of dataListeners) l(id, data);
    });
    backend.on('exit', (id, payload) => {
        // The engine reports `{ exitCode, signal? }`; the host wants the code. Flattening here
        // keeps `TerminalHost` ignorant of the engine's payload shape.
        for (const l of exitListeners) l(id, payload.exitCode);
    });

    return {
        open(spawn: PtySpawnOptions): PtyOpened {
            // The engine keys a pty on a caller-chosen id. Minted here, never by the renderer:
            // a renderer-chosen id that collided would JOIN an existing pty (`existing: true`)
            // rather than open a new one, silently.
            const id = `term_${randomUUID()}`;
            const { command, args } = spawn.command ? parseCommandLine(spawn.command) : options.defaultShell();

            const created = backend.create({
                id,
                cwd: spawn.cwd,
                shell: command,
                args,
                ...(spawn.cols === undefined ? {} : { cols: spawn.cols }),
                ...(spawn.rows === undefined ? {} : { rows: spawn.rows }),
                // Only when given — a plain shell gets the user's environment untouched.
                ...(spawn.env === undefined ? {} : { env: { ...spawn.env } }),
            });
            // An engine that could not start the process answers a non-positive pid rather than
            // throwing (fancy-term-host 0.10.0-rc.1 on the installed app: the helper could not be
            // executed from inside app.asar). That is NOT an open terminal, and handing it back
            // as one puts a pane on screen with nothing behind it and no error anywhere (§5).
            if (!(created.pid > 0)) {
                backend.kill(created.id);
                throw new Error(`the terminal engine could not spawn ${created.shell || command} (pid ${created.pid}) in ${spawn.cwd}`);
            }
            return { id: created.id, pid: created.pid, shell: created.shell, scrollback: created.scrollback };
        },
        write: (id, data) => backend.write(id, data),
        resize: (id, cols, rows) => backend.resize(id, cols, rows),
        kill: (id) => backend.kill(id),
        scrollback: (id) => backend.getScrollback(id),
        onData(listener) {
            dataListeners.add(listener);
            return () => dataListeners.delete(listener);
        },
        onExit(listener) {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
        },
    };
}

/** At-rest cipher for terminal snapshots — `fancy-term-host`'s own port, re-exported by shape. */
export interface SnapshotEncryptor {
    isAvailable(): boolean;
    encrypt(bytes: Buffer): Buffer;
    decrypt(bytes: Buffer): Buffer;
}

/**
 * The REAL engine, wired for this process.
 *
 * `fancy-term-host`'s in-process backend wants two ports: settings (which gate the cwd hook
 * and detached terminals) and a snapshot store (scrollback persisted across restarts, §6.5).
 *
 * ## The encryptor is the CALLER'S, on purpose
 *
 * The engine has a designed fallback: when the OS cannot encrypt, snapshots are written as
 * plaintext gzip with a `0x00` marker, because a resume that does not work is worse than a
 * scrollback on disk in the clear. The first version of this function hit that fallback by
 * passing an encryptor that always reported unavailable — not because the OS could not
 * encrypt, but because this module also loads under plain Node for the live check. A
 * development condition wearing the fallback's clothes, in a buffer where people paste tokens.
 * Fancy pointed it out, and the sharper half: the live check was then exercising the
 * PLAINTEXT branch, so the encrypted branch — the only one production takes — was the branch
 * nothing tested.
 *
 * So: Electron passes a `safeStorage`-backed encryptor; the live check passes one that really
 * transforms bytes; nothing here decides to write in the clear. The one in `fancy-term-host`
 * can still fall back on a machine that genuinely cannot encrypt, which is its call to make.
 *
 * Settings come from a tiny literal rather than a settings subsystem that does not exist yet:
 * cwd tracking on, detached terminals off. A missing key makes the engine apply its default.
 */
/**
 * The engine's settings port over GENIE'S settings (§6.5). fancy-term-host speaks 'on' / 'off' for
 * the two keys it gates on (the OSC-7 cwd hook, detached terminals); read LIVE so a change in the
 * Settings surface reaches the engine on its next look. A key Genie has no value for is left to the
 * engine's own default. This replaces a literal that made the two settings change nothing.
 */
export function engineSettingsFrom(values: () => Readonly<Record<string, boolean | string>>): { get(key: string): string | undefined } {
    const ENGINE_KEYS = new Set(['track_cwd', 'detached_terminals']);
    return {
        get: (key) => {
            if (!ENGINE_KEYS.has(key)) return undefined;
            const v = values()[key];
            return typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'string' ? v : undefined;
        },
    };
}

export function realFancyTermPort(userData: string, encryptor: SnapshotEncryptor, settingsValues: () => Readonly<Record<string, boolean | string>> = () => ({ track_cwd: true, detached_terminals: false })): PtyPort {
    const settings = engineSettingsFrom(settingsValues);
    configureInProcessBackend({
        settings,
        snapshots: createSnapshotStore({ baseDir: join(userData, 'terminal-snapshots'), encryptor }),
    });
    return fancyTermPort(inProcessBackend(), { defaultShell: () => resolveDefaultShell(settings) });
}
