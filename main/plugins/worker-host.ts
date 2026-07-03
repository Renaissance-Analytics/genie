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
import path from 'path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import type {
    PluginToolExecutor,
    PluginToolExecution,
    PluginToolResult,
} from './registry';
import type { PluginRow } from '../db';
import type { PluginManifest } from './manifest';

/** How long a single tool call may run before the worker is treated as hung. */
const CALL_TIMEOUT_MS = 30_000;

/** The embedded worker bootstrap (CommonJS). Materialised to disk + forked. */
const WORKER_ENTRY_SOURCE = `'use strict';
// Genie plugin worker — loads a plugin's tools module and runs handlers with a
// capability-scoped bridge. Communicates with the host over process.parentPort.
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

function makeBridge(ctx) {
    return {
        tool: ctx.toolName,
        terminalId: ctx.terminalId,
        fs: {
            readFile: (rel) => bridgeCall('fs.readFile', { rel: String(rel) }),
            writeFile: (rel, data) => bridgeCall('fs.writeFile', { rel: String(rel), data: String(data) }),
        },
        net: {
            fetch: (url, init) => bridgeCall('net.fetch', { url: String(url), init: init || null }),
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
        });
        const calls = new Map<number, PendingCall>();
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
                if (!pc) return;
                calls.delete(m.callId);
                clearTimeout(pc.timer);
                if (m.ok && m.result) pc.resolve(m.result);
                else pc.reject(new Error(m.error ?? 'plugin tool failed'));
            } else if (m.t === 'bridge' && typeof m.reqId === 'number') {
                void handleBridge(plugin, proc, m);
            }
            // 'log' messages are intentionally dropped in Phase 0.
        });

        const onGone = () => {
            for (const pc of calls.values()) {
                clearTimeout(pc.timer);
                pc.reject(new Error('plugin worker exited'));
            }
            calls.clear();
            if (workers.get(plugin.id)?.proc === proc) workers.delete(plugin.id);
        };
        proc.on('exit', onGone);

        return { proc, ready, calls };
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
            return await new Promise<PluginToolResult>((resolve, reject) => {
                const timer = setTimeout(() => {
                    w.calls.delete(callId);
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
 * GRANTED permissions and fails CLOSED: an ungranted capability is refused, and
 * the worker gets an error result it can surface to the agent.
 *
 * Phase 0 scope: the grant GATE is live (a plugin can only reach a capability it
 * was granted), but the actual fs/net EGRESS is intentionally not performed yet
 * — the path-guarded fs bridge lands with the generation tools (Phase 1, which
 * threads the caller's per-terminal workspace root through `guardedResolve`), and
 * network egress lands with egress enforcement (Phase 3). The hello-world plugin
 * declares no capabilities, so it exercises the seam without needing either.
 */
async function handleBridge(
    plugin: PluginRow,
    proc: UtilityProcess,
    m: HostMessage,
): Promise<void> {
    const reply = (ok: boolean, value?: unknown, error?: string) =>
        proc.postMessage({ t: 'bridge-result', reqId: m.reqId, ok, value, error });
    try {
        const grants = plugin.grants;
        const manifest = JSON.parse(plugin.manifest_json) as PluginManifest;
        if (m.op === 'fs.readFile' || m.op === 'fs.writeFile') {
            const fsCap = manifest.capabilities?.fs;
            if (!fsCap || fsCap.scope === 'none' || grants.fs[fsCap.scope] !== true) {
                return reply(false, undefined, 'fs access is not granted to this plugin');
            }
            return reply(
                false,
                undefined,
                'the path-guarded fs bridge is enabled with the generation tools in Phase 1',
            );
        }
        if (m.op === 'net.fetch') {
            const host = safeHost(String(m.params?.url ?? ''));
            if (!host || grants.network[host] !== true) {
                return reply(false, undefined, `network access to "${host ?? '?'}" is not granted`);
            }
            return reply(false, undefined, 'network egress is enabled in Phase 3');
        }
        return reply(false, undefined, `unknown bridge op "${m.op}"`);
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
