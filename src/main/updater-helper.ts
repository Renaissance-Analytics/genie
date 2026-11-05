import { parseEngineFrame } from '../core/engine-protocol.js';
import type { ClientTransport } from '../core/remote-protocol.js';
import { orphansUnder, type RunningProcess } from './upgrade.js';
import type { UpdaterPort } from './updater.js';
import { INSTALL_WAIT_MS, UPDATER_HELPER_LABEL, type InstallWait, type UpdaterConfig, type UpdaterEvent } from './updates-host.js';

/**
 * THE UPDATER HELPER'S RULES (the host split, P5b). The helper is Genie's own executable in its `--updater` mode
 * (updater-process.ts), started by genie-host when a check, a download or an install needs electron-updater. It links to the
 * running host with the host's token (never starts or replaces one), says it is the updater, and makes the library's calls
 * the host asks for — nothing else. Every part is a port, so the rules are tested without Electron.
 *
 * - Each request stands on its own: a helper started fresh for a download checks first, and for an install checks and
 *   downloads first (the library finds the file it already downloaded and does not fetch it again).
 * - An install is answered once the update is in hand ("armed"); the host then exits. The helper waits — bounded — until
 *   no Genie process maps the install (the host, the window, the browser, anything else from the install directory), and
 *   only then runs the installer. Past the bound it says so in words and runs nothing: an installer over a mapped
 *   executable is the failure this wait exists to prevent.
 * - It leaves when idle, or when the host's link closes outside an install.
 */

export interface UpdaterLinkClient {
    call(method: string, args: readonly unknown[]): Promise<unknown>;
    onEvent(listener: (event: UpdaterEvent) => void): () => void;
    onClose(listener: () => void): void;
    close(): void;
}

/** The helper's own small link: hello with the host's token and the updater's label, then `engine.updater` calls. */
export function connectUpdaterLink(transport: ClientTransport, token: string): Promise<UpdaterLinkClient | null> {
    return new Promise((resolve) => {
        let settled = false;
        let welcomed = false;
        let nextId = 1;
        const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
        const listeners = new Set<(event: UpdaterEvent) => void>();
        const closers = new Set<() => void>();
        const client: UpdaterLinkClient = {
            call(method, args) {
                const id = nextId++;
                return new Promise((res, rej) => {
                    pending.set(id, { resolve: res, reject: rej });
                    transport.send(JSON.stringify({ kind: 'call', id, method: 'engine.updater', args: [method, [...args]] }));
                });
            },
            onEvent(listener) {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
            onClose(listener) {
                closers.add(listener);
            },
            close() {
                transport.close();
            },
        };
        transport.onMessage((text) => {
            const parsed = parseEngineFrame(text);
            if (!parsed.ok) return;
            const m = parsed.message as unknown as { kind: string; channel?: string; payload?: unknown; id?: number; ok?: boolean; value?: unknown; reason?: string };
            if (!welcomed) {
                if (m.kind === 'welcome') {
                    welcomed = true;
                    (transport as ClientTransport & { trusted?: () => void }).trusted?.();
                    settled = true;
                    resolve(client);
                } else if (m.kind === 'refused') {
                    settled = true;
                    resolve(null);
                    transport.close();
                }
                return;
            }
            if (m.kind === 'event' && m.channel === 'updater.event') {
                for (const l of [...listeners]) l(m.payload as UpdaterEvent);
                return;
            }
            if (m.kind === 'result' && typeof m.id === 'number') {
                const p = pending.get(m.id);
                if (!p) return;
                pending.delete(m.id);
                if (m.ok === true) p.resolve(m.value ?? null);
                else p.reject(new Error(m.reason ?? 'the host refused'));
            }
        });
        transport.onClose(() => {
            if (!settled) { settled = true; resolve(null); }
            for (const p of pending.values()) p.reject(new Error('the host’s link closed'));
            pending.clear();
            for (const c of [...closers]) c();
        });
        transport.send(JSON.stringify({ kind: 'hello', auth: { kind: 'token', token }, label: UPDATER_HELPER_LABEL }));
    });
}

export interface UpdaterHelperPorts {
    /** A linked client, or null when no host answers. */
    link(): Promise<UpdaterLinkClient | null>;
    /** The library (electron-updater-port.ts in the helper; a fake in a test). */
    port: UpdaterPort;
    pid: number;
    processes(): Promise<readonly RunningProcess[]>;
    alive(pid: number): boolean;
    sleep(ms: number): Promise<void>;
    now(): number;
    /** The helper ends (app.quit). */
    quit(): void;
    log(line: string): void;
    /** How long with nothing asked before it leaves. Default `HELPER_IDLE_MS`. */
    idleMs?: number;
    caseInsensitive?: boolean;
    schedule?: (fn: () => void, ms: number) => () => void;
}

/** A helper with nothing to do leaves after this. */
export const HELPER_IDLE_MS = 2 * 60_000;
/** How often the install's wait looks again. */
const WAIT_POLL_MS = 250;

export function runUpdaterHelper(ports: UpdaterHelperPorts): { readonly done: Promise<void> } {
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => { finish = r; });
    const idleMs = ports.idleMs ?? HELPER_IDLE_MS;
    const schedule = ports.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    let cancelIdle: (() => void) | null = null;
    let busy = 0;
    let installing = false;
    let ended = false;
    /** What this process's library found and holds: a fresh helper has neither. */
    let checked: string | null = null;
    let downloaded = false;

    const end = (why: string): void => {
        if (ended) return;
        ended = true;
        cancelIdle?.();
        ports.log(`updater: ${why}`);
        ports.quit();
        finish();
    };
    const armIdle = (): void => {
        cancelIdle?.();
        cancelIdle = schedule(() => { if (busy === 0 && !installing) end(`nothing asked for ${Math.round(idleMs / 1000)} s; leaving`); }, idleMs);
    };
    const check = async (): Promise<{ version: string } | null> => {
        const found = await ports.port.check();
        if ((found?.version ?? null) !== checked) downloaded = false;
        checked = found?.version ?? null;
        return found;
    };
    const ensureChecked = async (): Promise<void> => {
        if (checked !== null) return;
        if ((await check()) === null) throw new Error('there is no update on offer any more');
    };
    const ensureDownloaded = async (onProgress: (percent: number) => void = () => {}): Promise<void> => {
        await ensureChecked();
        if (downloaded) return;
        await ports.port.download(onProgress);
        downloaded = true;
    };

    const run = async (client: UpdaterLinkClient, registered: Promise<void>, event: Extract<UpdaterEvent, { kind: 'request' }>): Promise<void> => {
        busy += 1;
        cancelIdle?.();
        try {
            await registered;
            let value: unknown = null;
            if (event.op === 'check') value = await check();
            else if (event.op === 'download') await ensureDownloaded((percent) => { void client.call('progress', [event.id, percent]).catch(() => {}); });
            else if (event.op === 'prepare') await ensureDownloaded();
            else {
                await ensureDownloaded();
                installing = true;
                // ARMED: the host goes on to exit; this process waits for every Genie process to be gone, then installs.
                await client.call('reply', [event.id, true, null]).catch(() => {});
                await install(event.wait ?? { pids: [], installDir: '', boundMs: INSTALL_WAIT_MS });
                return;
            }
            await client.call('reply', [event.id, true, value]).catch(() => {});
        } catch (error) {
            await client.call('reply', [event.id, false, error instanceof Error ? error.message : String(error)]).catch(() => {});
        } finally {
            busy -= 1;
            if (!installing && !ended) armIdle();
        }
    };

    const install = async (wait: InstallWait): Promise<void> => {
        const gone = await waitForGenieGone({
            wait,
            ownPid: ports.pid,
            processes: () => ports.processes(),
            alive: (pid) => ports.alive(pid),
            sleep: (ms) => ports.sleep(ms),
            now: () => ports.now(),
            ...(ports.caseInsensitive !== undefined ? { caseInsensitive: ports.caseInsensitive } : {}),
        });
        if (!gone.gone) {
            ports.log(gone.words);
            end('the update was not installed');
            return;
        }
        ports.log('updater: no Genie process maps the install any more; running the installer');
        ports.port.quitAndInstall();
    };

    void (async () => {
        const client = await ports.link().catch(() => null);
        if (client === null) { end('no Genie host answered; leaving'); return; }
        client.onClose(() => { if (!installing) end('the host’s link closed; leaving'); });
        let markRegistered: () => void = () => {};
        const registered = new Promise<void>((r) => { markRegistered = r; });
        client.onEvent((event) => {
            if (event.kind === 'configure') ports.port.configure(event.config);
            else void run(client, registered, event);
        });
        try {
            const answer = (await client.call('register', [ports.pid])) as { config?: UpdaterConfig } | null;
            if (answer?.config) ports.port.configure(answer.config);
        } catch (error) {
            end(`the host refused this updater: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        markRegistered();
        if (busy === 0) armIdle();
    })();

    return { done };
}

/**
 * Wait until no Genie process maps the install: the named pids (the host, the window that asked) dead, and nothing else
 * running from the install directory but this process's own tree. Bounded; past the bound, the words that say what held.
 */
export async function waitForGenieGone(input: {
    wait: InstallWait;
    ownPid: number;
    processes: () => Promise<readonly RunningProcess[]>;
    alive: (pid: number) => boolean;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    caseInsensitive?: boolean;
}): Promise<{ gone: true } | { gone: false; words: string }> {
    const until = input.now() + input.wait.boundMs;
    const caseInsensitive = input.caseInsensitive ?? process.platform === 'win32';
    for (;;) {
        const named = input.wait.pids.filter((pid) => pid !== input.ownPid && input.alive(pid));
        const listed = input.wait.installDir === '' ? [] : orphansUnder(await input.processes(), input.wait.installDir, input.ownPid, caseInsensitive);
        const holding = [
            ...named.map((pid) => listed.find((p) => p.pid === pid) ?? { pid, executable: 'Genie' }),
            ...listed.filter((p) => !named.includes(p.pid)),
        ];
        if (holding.length === 0) return { gone: true };
        if (input.now() >= until) {
            const list = holding.slice(0, 12).map((p) => `pid ${p.pid} (${p.executable})`).join(', ');
            return { gone: false, words: `updater: the update was not installed: Genie was still running from its install after ${Math.round(input.wait.boundMs / 1000)} s — ${list}. Nothing was replaced; open Genie and install the update again.` };
        }
        await input.sleep(WAIT_POLL_MS);
    }
}
