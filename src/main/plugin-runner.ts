import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { AccessDecision, AccessRequest, PluginTool } from '../core/plugins.js';

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
    /** For the error wording: `<pluginId>.<tool>`. Defaults to the tool name alone. */
    readonly label?: string | undefined;
}

export type RunResult = { ok: true; result: unknown } | { ok: false; reason: string };

export function runPluginTool(input: RunPluginToolInput): Promise<RunResult> {
    const label = input.label ?? `${pluginIdOf(input.pluginDir)}.${input.tool.name}`;
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', GENIE_PLUGIN_ID: pluginIdOf(input.pluginDir), GENIE_PLUGIN_TOOL: input.tool.name };
    const child = input.launch({ module: join(input.pluginDir, input.tool.run), process: input.tool.process, env });

    return new Promise<RunResult>((resolve) => {
        let done = false;
        const stderr: string[] = [];
        const finish = (r: RunResult) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
        const timer = setTimeout(() => { child.kill(); finish({ ok: false, reason: `${label} did not answer within ${input.timeoutMs} ms and was stopped` }); }, input.timeoutMs);

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

/** The real launch: Node, the module, the minimal env, pipes. Lines are split on the way in; the child never sees Genie's stdio. */
export function launchSubprocess(spec: LaunchSpec): PluginChild {
    const proc = spawn(process.execPath, [spec.module], { env: { ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
