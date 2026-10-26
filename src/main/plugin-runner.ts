import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AccessDecision, AccessRequest, PluginCapabilities, PluginTool } from '../core/plugins.js';

/**
 * PLUGIN TOOL CODE RUNS OUTSIDE GENIE'S PROCESS, AND EVERY REQUEST IT MAKES GOES THROUGH THE GUARD
 * (§6.7: "undeclared access does not exist, enforced at the bridge").
 *
 * The tool's module is launched in its own process with a MINIMAL environment — `PATH` and the two
 * `GENIE_PLUGIN_*` names, nothing of the user's shell, no provider key. Genie and the child speak
 * newline-delimited JSON: Genie writes `{ call: { tool, args, caller } }`; the child may write
 * `{ genie: { id, method, params } }` requests, each answered with `{ reply: { id, result } }` only
 * when the manifest declared that `genieApi` name (otherwise `{ reply: { id, error } }` with the
 * guard's reason, and the api is never called); the child ends with `{ result }`. A crash, a timeout
 * or a line that is not JSON is an error in words.
 *
 * `process: 'worker'` is launched as a subprocess too for now — a worker thread shares Genie's memory,
 * which is a weaker boundary than the manifest word promises; a subprocess is the honest one. The
 * launch is a port so the protocol is tested without spawning.
 */

export interface LaunchSpec {
    readonly module: string;
    readonly process: 'worker' | 'subprocess';
    readonly env: Readonly<Record<string, string>>;
    readonly sandbox: PluginSandbox;
}

/**
 * WHAT A PLUGIN TOOL'S PROCESS MAY TOUCH (genie#871): its own folder; the caller's workspace (read AND write) only when
 * the manifest declares `fs`; the network only to the declared hosts. Everything else is denied by Node's permission
 * model (`--permission`: no other file, no child process, no worker, no native addon, no `process.binding`) and, for the
 * network — which that model does not cover in this Node — by the guard loaded before the plugin (NET_GUARD).
 *
 * Not enforced at this layer: the manifest's `fs.extensions` (the permission model grants folders, not file kinds). The
 * folder is the boundary; the extensions remain what the editor bytes path checks (core/plugin-editors.ts).
 */
export interface PluginSandbox {
    readonly pluginDir: string;
    readonly workspace: string | null;
    readonly hosts: readonly string[];
}

export interface PluginChild {
    write(line: string): void;
    onLine(listener: (line: string) => void): void;
    onStderr(listener: (line: string) => void): void;
    onExit(listener: (code: number) => void): void;
    kill(): void;
}

export interface RunPluginToolInput {
    readonly pluginDir: string;
    readonly tool: PluginTool;
    readonly args: unknown;
    readonly caller: { agentName: string; workspaceId: string; workspacePath: string };
    readonly guard: (request: AccessRequest) => AccessDecision;
    readonly api: (method: string, params: unknown) => Promise<unknown>;
    readonly launch: (spec: LaunchSpec) => PluginChild;
    readonly timeoutMs: number;
    /** The manifest's capabilities — what the sandbox allows (genie#871). Absent: the narrowest sandbox. */
    readonly capabilities?: PluginCapabilities | undefined;
    /** For the error wording: `<pluginId>.<tool>`. Defaults to the tool name alone. */
    readonly label?: string | undefined;
}

export type RunResult = { ok: true; result: unknown } | { ok: false; reason: string };

export function runPluginTool(input: RunPluginToolInput): Promise<RunResult> {
    const label = input.label ?? `${pluginIdOf(input.pluginDir)}.${input.tool.name}`;
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', GENIE_PLUGIN_ID: pluginIdOf(input.pluginDir), GENIE_PLUGIN_TOOL: input.tool.name };
    const sandbox: PluginSandbox = { pluginDir: input.pluginDir, workspace: input.capabilities?.fs ? input.caller.workspacePath : null, hosts: [...(input.capabilities?.network.hosts ?? [])] };
    const child = input.launch({ module: join(input.pluginDir, input.tool.run), process: input.tool.process, env, sandbox });

    return new Promise<RunResult>((resolve) => {
        let done = false;
        const stderr: string[] = [];
        const finish = (r: RunResult) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
        // Settle BEFORE killing: a child whose exit lands synchronously (the test's fake; a real one may too) would otherwise be reported as a crash, not a timeout.
        const timer = setTimeout(() => { finish({ ok: false, reason: `${label} did not answer within ${input.timeoutMs} ms and was stopped` }); child.kill(); }, input.timeoutMs);

        child.onStderr((line) => { stderr.push(line); if (stderr.length > 20) stderr.shift(); });
        child.onExit((code) => {
            if (done) return;
            finish({ ok: false, reason: `${label} exited with code ${code} before answering${stderr.length > 0 ? `: ${stderr.join(' | ')}` : ''}` });
        });
        child.onLine((line) => {
            if (done) return;
            let msg: unknown;
            try { msg = JSON.parse(line); } catch { finish({ ok: false, reason: `${label} wrote something that is not a JSON line: ${line.slice(0, 200)}` }); child.kill(); return; }
            if (typeof msg !== 'object' || msg === null) { finish({ ok: false, reason: `${label} wrote something that is not a JSON object: ${line.slice(0, 200)}` }); child.kill(); return; }
            const m = msg as { result?: unknown; genie?: { id?: unknown; method?: unknown; params?: unknown } };
            if ('result' in m) { finish({ ok: true, result: m.result }); return; }
            if (m.genie && typeof m.genie === 'object') {
                const id = m.genie.id;
                const method = typeof m.genie.method === 'string' ? m.genie.method : '';
                // THE BRIDGE: declared or it does not exist. The guard's words go back to the plugin.
                const decision = input.guard({ kind: 'genieApi', name: method });
                if (!decision.allowed) { child.write(JSON.stringify({ reply: { id, error: decision.reason } })); return; }
                void input.api(method, m.genie.params)
                    .then((result) => child.write(JSON.stringify({ reply: { id, result } })))
                    .catch((error: unknown) => child.write(JSON.stringify({ reply: { id, error: error instanceof Error ? error.message : String(error) } })));
            }
        });

        child.write(JSON.stringify({ call: { tool: input.tool.name, args: input.args, caller: input.caller } }));
    });
}

function pluginIdOf(pluginDir: string): string {
    return pluginDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? pluginDir;
}

/**
 * The command a plugin subprocess runs (genie#871): the running binary on the module, with the minimal env — and, under
 * Electron, ELECTRON_RUN_AS_NODE, without which Genie.exe starts a SECOND GENIE instead of running the module (the tool
 * never ran, and the single-instance lock's handler pulled the main window to the front).
 */
export function subprocessCommand(spec: LaunchSpec, runtime: { execPath: string; electron: boolean; netGuard: string }): { file: string; args: string[]; env: Record<string, string> } {
    const { pluginDir, workspace, hosts } = spec.sandbox;
    const args = [
        // genie#871: the sandbox. Reads: its own folder and the guard; the workspace (read and write) only when declared.
        '--permission',
        `--allow-fs-read=${pluginDir}`,
        `--allow-fs-read=${runtime.netGuard}`,
        ...(workspace !== null ? [`--allow-fs-read=${workspace}`, `--allow-fs-write=${workspace}`] : []),
        // The network guard runs before the plugin's own code (a file URL: a Windows path is not a module specifier).
        `--import=${pathToFileURL(runtime.netGuard).href}`,
        spec.module,
    ];
    return { file: runtime.execPath, args, env: { ...spec.env, GENIE_PLUGIN_HOSTS: hosts.join(','), ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } };
}

/**
 * THE NETWORK GUARD (genie#871), loaded with `--import` before the plugin. Node's permission model has no network switch
 * in the Node Genie ships (measured 2026-10-26: Electron 45 as Node is 24.22, and `--allow-net` is "bad option"), so every
 * TCP connection goes through here — net, http, https, fetch and WebSocket all end in `net.Socket#connect` — and is
 * allowed only to a declared host (`api.example.com`, or `*.example.com` for its subdomains). UDP and local sockets
 * (a path, a named pipe) are never declared, so never allowed. The hosts are read ONCE, before the plugin runs.
 */
const NET_GUARD = `import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
const hosts = (process.env.GENIE_PLUGIN_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
delete process.env.GENIE_PLUGIN_HOSTS;
const allowed = (host) => {
    const h = String(host).toLowerCase().replace(/^\\[|\\]$/g, '');
    return hosts.some((d) => d === h || (d.startsWith('*.') && h.endsWith(d.slice(1))));
};
const denied = (host) => Object.assign(new Error('network access to ' + host + ' is not declared by this plugin'), { code: 'ERR_GENIE_NETWORK_DENIED' });
const hostOf = (args) => {
    const a = Array.isArray(args[0]) ? args[0][0] : args[0];
    // A TCP connection names a port (http's options also carry \`path\` — the URL's path, not a socket); only a
    // connection with no port and no host is a local socket (a path, a named pipe).
    if (a !== null && typeof a === 'object') return a.port !== undefined || a.host !== undefined || a.hostname !== undefined ? (a.host ?? a.hostname ?? 'localhost') : a.path !== undefined ? 'local socket ' + a.path : 'localhost';
    if (typeof a === 'number' || /^[0-9]+$/.test(String(a))) return typeof args[1] === 'string' ? args[1] : 'localhost';
    return 'local socket ' + a;
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const host = hostOf(args);
    if (!allowed(host)) { const error = denied(host); process.nextTick(() => this.destroy(error)); return this; }
    return connect.apply(this, args);
};
const tlsConnect = tls.connect;
tls.connect = function (...args) { const host = hostOf(args); if (!allowed(host)) throw denied(host); return tlsConnect.apply(this, args); };
dgram.createSocket = function () { throw denied('UDP'); };
`;

/** The guard, written once by its content into `dir` (Genie's home): the same file every launch, a new one when it changes. */
export function ensureNetGuard(dir: string): string {
    const file = join(dir, `net-guard-${createHash('sha256').update(NET_GUARD).digest('hex').slice(0, 12)}.mjs`);
    if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, NET_GUARD, { encoding: 'utf8', mode: 0o644 });
    }
    return file;
}

/** The real launch: Node, the module, the minimal env, pipes. Lines are split on the way in; the child never sees Genie's stdio. */
export function launchSubprocessIn(guardDir: string): (spec: LaunchSpec) => PluginChild {
    return (spec) => launchSubprocess(spec, guardDir);
}

function launchSubprocess(spec: LaunchSpec, guardDir: string): PluginChild {
    const cmd = subprocessCommand(spec, { execPath: process.execPath, electron: Boolean(process.versions.electron), netGuard: ensureNetGuard(guardDir) });
    const proc = spawn(cmd.file, cmd.args, { env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const lines = (stream: NodeJS.ReadableStream, emit: (line: string) => void) => {
        let buffer = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
            buffer += chunk;
            let at: number;
            while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1); if (line.length > 0) emit(line); }
        });
    };
    const outListeners: Array<(line: string) => void> = [];
    const errListeners: Array<(line: string) => void> = [];
    lines(proc.stdout!, (l) => { for (const cb of outListeners) cb(l); });
    lines(proc.stderr!, (l) => { for (const cb of errListeners) cb(l); });
    return {
        write: (line) => { proc.stdin!.write(`${line}\n`); },
        onLine: (l) => { outListeners.push(l); },
        onStderr: (l) => { errListeners.push(l); },
        onExit: (l) => { proc.on('exit', (code) => l(code ?? -1)); },
        kill: () => { proc.kill(); },
    };
}
