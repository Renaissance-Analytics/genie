/**
 * The DEFAULT plugin-tool executor: an Electron `utilityProcess` WORKER per
 * enabled plugin (§12.1 — worker is the secure default). The worker is a
 * separate OS process with NO `window`, no Electron, and — critically — no
 * ambient Genie authority: a plugin handler is handed a CAPABILITY-SCOPED bridge
 * (`fs`/`net`) that proxies every request back here, where it is enforced
 * against the plugin's GRANTED permissions + the workspace path guard
 * (`guardedResolve`, the same discipline as `files/ipc.ts`). Nothing the plugin
 * does touches the filesystem or network except through that mediated bridge.
 *
 * The worker entry is MATERIALISED to `<userData>/plugins/.worker/` from an
 * embedded CJS string, so it needs no webpack entry / electron-builder copy step
 * and works identically in dev and packaged (asar) builds — it runs from a
 * writable path outside the archive.
 *
 * NOTE (honest scope): the utilityProcess is a Node process, so a determined
 * plugin could still `require('fs')` directly inside the worker. Phase 0
 * delivers the PROCESS boundary + the mediated capability bridge; a locked-down
 * loader that DENIES ambient `require('fs'/'net')` (a SES/vm realm or a
 * restricted module loader) is a Phase 3 hardening item — flagged, not silently
 * assumed. The subprocess escape hatch (§12.1) is likewise Phase 3.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import type {
    PluginToolExecutor,
    PluginToolExecution,
    PluginToolResult,
} from './registry';
import { getWorkspace, type PluginRow } from '../db';
import { workspaceIdOfTerminal, SYSTEM_WORKSPACE_ID } from '../terminal/workspace-of-terminal';
import { runPluginFsOp, isPluginFsOp } from './fs-bridge';
import type { PluginManifest } from './manifest';

/** How long a single tool call may run before the worker is treated as hung. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * Resolve a call's AUTHORITATIVE workspace root from its terminal id — computed
 * host-side (trusted), NEVER supplied by the worker. A real workspace → its
 * path; the synthetic System workspace → the home directory (mirroring
 * openFileForUser / the env tools); unresolved → null (fs ops fail closed).
 */
function rootForTerminal(terminalId: string): string | null {
    const wsId = terminalId ? workspaceIdOfTerminal(terminalId) : null;
    if (!wsId) return null;
    if (wsId === SYSTEM_WORKSPACE_ID) return os.homedir();
    return getWorkspace(wsId)?.path ?? null;
}

/**
 * Genie's node_modules root — passed to the worker so a bundled first-party
 * plugin can resolve Genie-provided libs (dark-slide / holy-sheet). Prefers the
 * resolver (dev/test), falling back to the app path (packaged). Null when
 * neither resolves (the plugin's require then fails, contained as a tool error).
 */
function genieNodeModulesDir(): string | null {
    try {
        const entry = require.resolve('@particle-academy/dark-slide');
        const marker = `${path.sep}node_modules${path.sep}`;
        const i = entry.lastIndexOf(marker);
        if (i !== -1) return entry.slice(0, i + marker.length - 1);
    } catch {
        /* fall through to the app-path fallback */
    }
    try {
        return path.join(app.getAppPath(), 'node_modules');
    } catch {
        return null;
    }
}

/** The child env: inherit the host's, plus the plugin module-resolution fallback. */
function workerEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') env[k] = v;
    }
    const nm = genieNodeModulesDir();
    if (nm) env.GENIE_PLUGIN_NODE_PATH = nm;
    return env;
}

/** The embedded worker bootstrap (CommonJS). Materialised to disk + forked. */
const WORKER_ENTRY_SOURCE = `'use strict';
// Genie plugin worker — loads a plugin's tools module and runs handlers with a
// capability-scoped bridge. Communicates with the host over process.parentPort.

// Module resolution fallback: a bundled first-party plugin (Presentation /
// Spreadsheet) requires Genie-provided libs (@particle-academy/dark-slide /
// holy-sheet) that live in GENIE's node_modules, not under the plugin's own dir.
// The host passes that node_modules root in GENIE_PLUGIN_NODE_PATH; add it to the
// global module search path so bare requires resolve it. Best-effort — a plugin
// that bundles its own deps resolves them the normal way regardless.
(function seedModulePaths() {
    try {
        const extra = String(process.env.GENIE_PLUGIN_NODE_PATH || '').trim();
        if (!extra) return;
        const Module = require('module');
        const path = require('path');
        const parts = extra.split(path.delimiter).filter(Boolean);
        for (const p of parts) if (!Module.globalPaths.includes(p)) Module.globalPaths.push(p);
        process.env.NODE_PATH = [process.env.NODE_PATH, ...parts].filter(Boolean).join(path.delimiter);
        Module._initPaths();
    } catch (e) {
        /* resolution fallback is best-effort */
    }
})();

const port = process.parentPort;
const required = new Map();
const pending = new Map();
let bridgeSeq = 0;

function bridgeCall(op, params) {
    return new Promise((resolve, reject) => {
        const reqId = ++bridgeSeq;
        pending.set(reqId, { resolve, reject });
        port.postMessage({ t: 'bridge', reqId, op, params });
    });
}

/** Coerce a handler-supplied byte value (Uint8Array / ArrayBuffer / number[]) to Uint8Array. */
function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (Array.isArray(bytes)) return Uint8Array.from(bytes);
    return new Uint8Array(0);
}

function makeBridge(ctx) {
    // Every bridge request carries the host-issued callId so the host can resolve
    // it against the AUTHORITATIVE per-call workspace root (the worker never
    // supplies a root/terminal itself — that would let a plugin target another
    // workspace).
    const callId = ctx.callId;
    const withId = (p) => Object.assign({ callId: callId }, p || {});
    return {
        tool: ctx.toolName,
        terminalId: ctx.terminalId,
        fs: {
            readFile: (rel) => bridgeCall('fs.readFile', withId({ rel: String(rel) })),
            writeFile: (rel, data) => bridgeCall('fs.writeFile', withId({ rel: String(rel), data: String(data) })),
            readBytes: async (rel) => {
                const res = await bridgeCall('fs.readBytes', withId({ rel: String(rel) }));
                return Buffer.from(String(res && res.base64 != null ? res.base64 : ''), 'base64');
            },
            writeBytes: (rel, bytes) =>
                bridgeCall('fs.writeBytes', withId({ rel: String(rel), base64: Buffer.from(toU8(bytes)).toString('base64') })),
        },
        net: {
            fetch: (url, init) => bridgeCall('net.fetch', withId({ url: String(url), init: init || null })),
        },
        log: (msg) => port.postMessage({ t: 'log', msg: String(msg) }),
    };
}

function requireCached(file) {
    if (required.has(file)) return required.get(file);
    const mod = require(file);
    required.set(file, mod);
    return mod;
}

function normalize(result) {
    if (result && typeof result === 'object' && Array.isArray(result.content)) return result;
    if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
    return { content: [{ type: 'text', text: JSON.stringify(result == null ? null : result) }] };
}

async function handleCall(m) {
    try {
        const mod = requireCached(m.entryFile);
        const pick = (o) => (o && typeof o[m.toolName] === 'function' ? o[m.toolName] : null);
        const fn = pick(mod) || (mod && pick(mod.default));
        if (!fn) throw new Error('handler "' + m.toolName + '" is not exported by ' + m.entryFile);
        const result = await fn(m.args || {}, makeBridge(m));
        port.postMessage({ t: 'call-result', callId: m.callId, ok: true, result: normalize(result) });
    } catch (e) {
        port.postMessage({ t: 'call-result', callId: m.callId, ok: false, error: (e && e.message) ? e.message : String(e) });
    }
}

port.on('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'call') { handleCall(m); return; }
    if (m.t === 'bridge-result') {
        const p = pending.get(m.reqId);
        if (p) { pending.delete(m.reqId); if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error || 'bridge error')); }
    }
});
port.postMessage({ t: 'ready' });
`;

interface HostMessage {
    t: string;
    callId?: number;
    ok?: boolean;
    result?: PluginToolResult;
    error?: string;
    reqId?: number;
    op?: string;
    params?: Record<string, unknown>;
    msg?: string;
}

interface PendingCall {
    resolve: (r: PluginToolResult) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

/** One live worker process for a plugin. */
interface PluginWorker {
    proc: UtilityProcess;
    ready: Promise<void>;
    calls: Map<number, PendingCall>;
    /**
     * callId → the AUTHORITATIVE workspace root for that in-flight call (host-
     * computed from the trusted terminal id). A bridge fs op is guard-resolved
     * against the root of the call whose id it carries — never a worker-supplied
     * path — so a plugin can only ever write inside a workspace it was legitimately
     * invoked in.
     */
    callRoots: Map<number, string | null>;
}

/** Resolve (once) the materialised worker-entry path, writing it if stale. */
let entryPathCache: string | null = null;
function workerEntryPath(): string {
    if (entryPathCache) return entryPathCache;
    const dir = path.join(app.getPath('userData'), 'plugins', '.worker');
    fs.mkdirSync(dir, { recursive: true });
    // Version the file by a content hash so an updated bootstrap replaces it.
    const hash = crypto.createHash('sha256').update(WORKER_ENTRY_SOURCE).digest('hex').slice(0, 12);
    const file = path.join(dir, `worker-entry-${hash}.cjs`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, WORKER_ENTRY_SOURCE, { mode: 0o600 });
    entryPathCache = file;
    return file;
}

/** The absolute path to a tool's handler module (its `run` → `entry` mapping). */
function toolEntryFile(plugin: PluginRow, manifest: PluginManifest, runKey: string): string | null {
    const rel = manifest.entry?.[runKey as 'tools'];
    if (!rel) return null;
    return path.join(plugin.install_path, rel);
}

export function createWorkerExecutor(): PluginToolExecutor {
    const workers = new Map<string, PluginWorker>();

    function spawn(plugin: PluginRow): PluginWorker {
        const proc = utilityProcess.fork(workerEntryPath(), [], {
            serviceName: `genie-plugin-${plugin.namespace}`,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: workerEnv(),
        });
        const calls = new Map<number, PendingCall>();
        const callRoots = new Map<number, string | null>();
        let markReady: () => void = () => {};
        const ready = new Promise<void>((res) => {
            markReady = res;
        });

        proc.on('message', (raw: unknown) => {
            const m = raw as HostMessage;
            if (!m || typeof m !== 'object') return;
            if (m.t === 'ready') {
                markReady();
            } else if (m.t === 'call-result' && typeof m.callId === 'number') {
                const pc = calls.get(m.callId);
                calls.delete(m.callId);
                callRoots.delete(m.callId); // the call is done — drop its scope
                if (!pc) return;
                clearTimeout(pc.timer);
                if (m.ok && m.result) pc.resolve(m.result);
                else pc.reject(new Error(m.error ?? 'plugin tool failed'));
            } else if (m.t === 'bridge' && typeof m.reqId === 'number') {
                void handleBridge(plugin, proc, callRoots, m);
            }
            // 'log' messages are intentionally dropped in Phase 0.
        });

        const onGone = () => {
            for (const pc of calls.values()) {
                clearTimeout(pc.timer);
                pc.reject(new Error('plugin worker exited'));
            }
            calls.clear();
            callRoots.clear();
            if (workers.get(plugin.id)?.proc === proc) workers.delete(plugin.id);
        };
        proc.on('exit', onGone);

        return { proc, ready, calls, callRoots };
    }

    function workerFor(plugin: PluginRow): PluginWorker {
        let w = workers.get(plugin.id);
        if (!w) {
            w = spawn(plugin);
            workers.set(plugin.id, w);
        }
        return w;
    }

    let callSeq = 0;

    return {
        async call(exec: PluginToolExecution): Promise<PluginToolResult> {
            const { plugin, manifest, tool, toolName, args, terminalId } = exec;
            const process = tool.process ?? 'worker';
            if (process === 'subprocess') {
                throw new Error(
                    'subprocess isolation is a Phase 3 escape hatch; this plugin tool declares process:"subprocess" which is not yet supported',
                );
            }
            const entryFile = toolEntryFile(plugin, manifest, tool.run ?? 'tools');
            if (!entryFile) {
                throw new Error(`plugin "${plugin.name}" has no entry module for tool "${toolName}"`);
            }
            const w = workerFor(plugin);
            await w.ready;
            const callId = ++callSeq;
            // Bind this call's AUTHORITATIVE workspace root NOW (host-side, from the
            // trusted terminal id) so bridge fs ops resolve against it — not against
            // anything the worker reports.
            w.callRoots.set(callId, rootForTerminal(terminalId));
            return await new Promise<PluginToolResult>((resolve, reject) => {
                const timer = setTimeout(() => {
                    w.calls.delete(callId);
                    w.callRoots.delete(callId);
                    reject(new Error(`plugin tool "${toolName}" timed out after ${CALL_TIMEOUT_MS}ms`));
                }, CALL_TIMEOUT_MS);
                w.calls.set(callId, { resolve, reject, timer });
                w.proc.postMessage({ t: 'call', callId, entryFile, toolName, args, terminalId });
            });
        },
        dispose(pluginId: string): void {
            const w = workers.get(pluginId);
            if (!w) return;
            workers.delete(pluginId);
            try {
                w.proc.kill();
            } catch {
                /* already gone */
            }
        },
    };
}

/**
 * Host-side capability bridge. Every request is enforced against the plugin's
 * GRANTED permissions and fails CLOSED: an ungranted or undeclared capability is
 * refused, and the worker gets an error result it can surface to the agent.
 *
 * Phase 1 lands the path-guarded, extension-limited, workspace-scoped FS bridge
 * (deliverable #2): an fs op is delegated to {@link runPluginFsOp}, which checks
 * the manifest declaration + the granular grant + the AUTHORITATIVE per-call
 * workspace root (looked up from `callRoots` by the callId the worker echoed —
 * the worker never supplies a root), then guard-resolves the write under that
 * root against the plugin's extension allow-list (`guardedResolve` in
 * `files/ipc.ts`). NETWORK egress remains gated-but-not-performed until Phase 3.
 */
async function handleBridge(
    plugin: PluginRow,
    proc: UtilityProcess,
    callRoots: Map<number, string | null>,
    m: HostMessage,
): Promise<void> {
    const reply = (ok: boolean, value?: unknown, error?: string) =>
        proc.postMessage({ t: 'bridge-result', reqId: m.reqId, ok, value, error });
    try {
        const params = (m.params ?? {}) as Record<string, unknown>;
        const op = m.op ?? '';
        if (isPluginFsOp(op)) {
            const manifest = JSON.parse(plugin.manifest_json) as PluginManifest;
            const callId = typeof params.callId === 'number' ? params.callId : -1;
            const root = callRoots.get(callId) ?? null;
            const r = await runPluginFsOp(manifest, plugin.grants, root, op, params);
            return reply(r.ok, r.value, r.error);
        }
        if (op === 'net.fetch') {
            const host = safeHost(String(params.url ?? ''));
            if (!host || plugin.grants.network[host] !== true) {
                return reply(false, undefined, `network access to "${host ?? '?'}" is not granted`);
            }
            return reply(false, undefined, 'network egress is enabled in Phase 3');
        }
        return reply(false, undefined, `unknown bridge op "${op}"`);
    } catch (e) {
        reply(false, undefined, e instanceof Error ? e.message : String(e));
    }
}

/** Extract the lowercased host from a URL, or null when unparseable. */
function safeHost(url: string): string | null {
    try {
        return new URL(url).host.toLowerCase();
    } catch {
        return null;
    }
}
