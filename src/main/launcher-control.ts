import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LineTransport } from '../core/line-transport.js';
import { capability, remoteOffer, type Track } from '../core/protocol-version.js';
import { connectSocket, pidAlive } from './engine-launch.js';

/**
 * THE LAUNCHER'S CONTROL WIRE, FROM TYPESCRIPT (Tynn #1058 L4). native/launcher/src/control.rs serves it: JSON lines on the
 * endpoint `<runtime>/launcher.json` names (a per-user named pipe on Windows, `launcher.sock` elsewhere), the token in
 * `<runtime>/launcher.token`, a `hello` with the caller's offer (its own track, `launcher@1`; the shared table's "launcher to
 * host on the control wire"), then one `call` and its `result`. The client asks it for the host (`launcher.ensureHost`,
 * the directory's Start); the host asks it for the Genie browser (`launcher.startBrowser`).
 *
 * Every answer is words, never a throw: a launcher that is not there, refuses, or does not answer is said.
 */
export const CAP_LAUNCHER = capability('launcher', 1);

export interface LauncherWire {
    readonly runtimeDir: string;
    /** The caller's track: `client` for a window, `host` for genie-host. */
    readonly track: Track;
    readonly build?: string | null;
    readonly readFile?: (file: string) => string | null;
    readonly alive?: (pid: number) => boolean;
    readonly connectTo?: (endpoint: string) => Promise<LineTransport>;
    readonly timeoutMs?: number;
}

export type LauncherAnswer = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string; readonly code?: string };

const DEFAULT_TIMEOUT_MS = 90_000;

function readOrNull(file: string): string | null {
    try { return readFileSync(file, 'utf8'); } catch { return null; }
}

interface Found { readonly endpoint: string; readonly token: string }

function find(wire: LauncherWire): Found | null {
    const read = wire.readFile ?? readOrNull;
    let record: { pid?: unknown; endpoint?: unknown };
    try { record = JSON.parse(read(join(wire.runtimeDir, 'launcher.json')) ?? 'null') as typeof record; } catch { return null; }
    if (!record || typeof record.pid !== 'number' || typeof record.endpoint !== 'string' || record.endpoint === '') return null;
    if (!(wire.alive ?? pidAlive)(record.pid)) return null;
    const token = read(join(wire.runtimeDir, 'launcher.token'))?.trim() ?? '';
    return token === '' ? null : { endpoint: record.endpoint, token };
}

/** Whether a launcher of this user answers here: its record, a live pid and its token. Nothing is dialled. */
export function launcherReachable(wire: LauncherWire): boolean {
    return find(wire) !== null;
}

/** One call: hello, the call, its result; the link closed after, whatever happened. */
export async function callLauncher(wire: LauncherWire, method: string, args: readonly unknown[] = []): Promise<LauncherAnswer> {
    const found = find(wire);
    if (found === null) return { ok: false, reason: 'Genie’s launcher is not running.', code: 'no-launcher' };
    let transport: LineTransport;
    try {
        transport = await (wire.connectTo ?? connectSocket)(found.endpoint);
    } catch (error) {
        return { ok: false, reason: `Genie’s launcher did not answer (${error instanceof Error ? error.message : String(error)}).` };
    }
    const timeoutMs = wire.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<LauncherAnswer>((resolve) => {
        let settled = false;
        const offs: (() => void)[] = [];
        const done = (answer: LauncherAnswer): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            for (const off of offs) off();
            transport.close();
            resolve(answer);
        };
        const timer = setTimeout(() => done({ ok: false, reason: `Genie’s launcher did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.` }), timeoutMs);
        offs.push(transport.onClose(() => done({ ok: false, reason: 'Genie’s launcher closed the link before it answered.' })));
        offs.push(transport.onMessage((text) => {
            let frame: { kind?: unknown; id?: unknown; ok?: unknown; value?: unknown; reason?: unknown; code?: unknown };
            try { frame = JSON.parse(text) as typeof frame; } catch { return; }
            if (frame.kind === 'refused') { done({ ok: false, reason: typeof frame.reason === 'string' ? frame.reason : 'Genie’s launcher refused this program.' }); return; }
            if (frame.kind === 'welcome') { transport.trusted(); transport.send(JSON.stringify({ kind: 'call', id: 1, method, args: [...args] })); return; }
            if (frame.kind === 'result' && frame.id === 1) {
                if (frame.ok === true) done({ ok: true, value: frame.value ?? null });
                else done({ ok: false, reason: typeof frame.reason === 'string' ? frame.reason : `${method} failed`, ...(typeof frame.code === 'string' ? { code: frame.code } : {}) });
            }
        }));
        const offer = remoteOffer(wire.track, wire.build ?? null, [CAP_LAUNCHER]);
        transport.send(JSON.stringify({ kind: 'hello', auth: { kind: 'token', token: found.token }, label: `genie ${wire.track}`, track: offer.track, ...(offer.build ? { build: offer.build } : {}), schema: offer.schema, minSchema: offer.minSchema, capabilities: offer.capabilities }));
    });
}

/** The wire in a runtime folder, for a caller of `track`. */
export function launcherWire(runtimeDir: string, track: Track, build: string | null = null): LauncherWire {
    return { runtimeDir, track, build };
}
