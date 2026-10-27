import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A STAND-IN CLAUDE CODE CLI for prism-acp's real `ClaudeDriver` (genie#1235, prism-acp 0.30.0).
 *
 * It speaks just enough of `claude --print --input-format stream-json` for the driver: it answers the `initialize`
 * control request with a `claude_code_version` the test chooses, and for each user turn it writes `system/init` and a
 * `result`. Like Claude Code it RUNS the PreToolUse hook prism-acp wrote into its `--settings` once per turn — exec
 * form (`command` + `args`, no shell) when the settings say so, the command string through a shell otherwise — with
 * its own environment (where prism-acp put the approval channel) and a Bash call as the hook's stdin.
 *
 * `probe` replaces the hook SCRIPT (approve.cjs) with one that records the `ELECTRON_RUN_AS_NODE` it was started with
 * and answers prism-acp's explicit allow (42): what the hook process's runtime would be told, measured, not read from a
 * string. Everything it observed is written to `out/`.
 */
export interface FakeClaude {
    /** The stand-in: run it as `process.execPath <script>` (prism-acp's `binary` + `binaryArgs`). */
    readonly script: string;
    readonly dir: string;
    /** What the hook run produced: its exit status, its stdout, and what the probe saw (probe mode). */
    hookRun(): { status: number | null; stdout: string; stderr: string; electronRunAsNode?: string } | null;
    /** The `--settings` file prism-acp handed the CLI, as written. */
    settings(): { hooks?: { PreToolUse?: { hooks: { command: string; args?: string[] }[] }[] } } | null;
    cleanup(): void;
}

export function fakeClaude(options: { readonly version: string; readonly hook?: 'none' | 'run' | 'probe' }): FakeClaude {
    const dir = mkdtempSync(join(tmpdir(), 'genie-fake-claude-'));
    const script = join(dir, 'claude.cjs');
    const probe = join(dir, 'probe.cjs');
    const out = (name: string) => join(dir, name);
    writeFileSync(probe, `require('fs').writeFileSync(${JSON.stringify(out('probe.txt'))}, process.env.ELECTRON_RUN_AS_NODE === undefined ? '<unset>' : process.env.ELECTRON_RUN_AS_NODE);\nprocess.exit(42);\n`);
    writeFileSync(script, `'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const VERSION = ${JSON.stringify(options.version)};
const MODE = ${JSON.stringify(options.hook ?? 'none')};
const PROBE = ${JSON.stringify(probe)};
const OUT = (n) => require('path').join(${JSON.stringify(dir)}, n);
const sessionId = randomUUID();
const at = process.argv.indexOf('--settings');
const settingsPath = at > 0 ? process.argv[at + 1] : null;
const settings = settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : null;
if (settings) fs.writeFileSync(OUT('settings.json'), JSON.stringify(settings));
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
function runHook() {
    const entry = settings && settings.hooks && settings.hooks.PreToolUse && settings.hooks.PreToolUse[0] && settings.hooks.PreToolUse[0].hooks[0];
    if (!entry) return;
    const input = JSON.stringify({ session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'toolu_01', cwd: process.cwd(), permission_mode: 'bypassPermissions' });
    // What reaches the hook process must come from prism-acp's hook, never from this process's own environment.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let r;
    if (Array.isArray(entry.args)) {
        const args = MODE === 'probe' ? entry.args.map((a) => /approve\\.cjs$/i.test(a) ? PROBE : a) : entry.args;
        r = spawnSync(entry.command, args, { input, env, encoding: 'utf8', windowsHide: true });
    } else {
        const command = MODE === 'probe' ? entry.command.replace(/[^"]*approve\\.cjs/i, PROBE) : entry.command;
        r = spawnSync(command, { input, env, encoding: 'utf8', shell: true, windowsHide: true });
    }
    const seen = fs.existsSync(OUT('probe.txt')) ? fs.readFileSync(OUT('probe.txt'), 'utf8') : undefined;
    fs.writeFileSync(OUT('hook.json'), JSON.stringify({ status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ...(seen === undefined ? {} : { electronRunAsNode: seen }) }));
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.type === 'control_request') {
            const response = frame.request && frame.request.subtype === 'initialize' ? { models: [], claude_code_version: VERSION } : {};
            send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
        } else if (frame.type === 'user') {
            send({ type: 'system', subtype: 'init', session_id: sessionId, claude_code_version: VERSION, tools: ['Bash'], mcp_servers: [], model: 'claude-test' });
            if (MODE !== 'none') runHook();
            send({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId, duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
        }
    }
});
process.stdin.on('end', () => process.exit(0));
`);
    const read = <T>(name: string): T | null => (existsSync(out(name)) ? (JSON.parse(readFileSync(out(name), 'utf8')) as T) : null);
    return {
        script,
        dir,
        hookRun: () => read('hook.json'),
        settings: () => read('settings.json'),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

/** Run `body` as if this process were Electron's main process (`process.versions.electron` set), and put it back. */
export async function asElectron<T>(body: () => Promise<T>): Promise<T> {
    const versions = process.versions as Record<string, string | undefined>;
    const before = versions.electron;
    Object.defineProperty(process.versions, 'electron', { value: '45.0.0', configurable: true, enumerable: true, writable: true });
    try { return await body(); }
    finally {
        if (before === undefined) delete versions.electron;
        else Object.defineProperty(process.versions, 'electron', { value: before, configurable: true, enumerable: true, writable: true });
    }
}
