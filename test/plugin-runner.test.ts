import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginManifest } from '../src/core/plugins.js';
import { bridgeAccess } from '../src/core/plugins.js';
import { runPluginTool, type LaunchSpec, type PluginChild } from '../src/main/plugin-runner.js';

/**
 * PLUGIN TOOL CODE RUNS OUTSIDE GENIE'S PROCESS, AND EVERY REQUEST IT MAKES GOES THROUGH THE GUARD (§6.7:
 * "undeclared access does not exist, enforced at the bridge"). The runner launches the tool's module in
 * its own process with a MINIMAL environment — nothing of the user's shell, no provider keys — speaks
 * newline-delimited JSON with it, answers its `genie` requests only when the manifest declared that
 * capability, and turns a crash, a timeout or garbage into an error in words. The launch is a port, so
 * none of this spawns anything here.
 */

const manifest: PluginManifest = {
    id: 'acme.lint',
    name: 'Acme Lint',
    version: '1.0.0',
    publisher: { name: 'Acme', keyId: 'acme-1' },
    mcpTools: [{ name: 'lint', description: 'Lint a file', inputSchema: { type: 'object' }, run: 'tools/lint.js', process: 'subprocess', gated: false }],
    capabilities: { network: { hosts: [] }, genieApi: ['knowledge.search'] },
};
const tool = manifest.mcpTools[0]!;
const guard = (request: Parameters<typeof bridgeAccess>[1]) => bridgeAccess(manifest, request);
const caller = { agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' };

/** A fake child: what the runner wrote to it, and a script of lines it says back. */
function fakeChild(script: (written: string) => Array<string | { exit: number } | { wait: number }>) {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = new EventEmitter();
    const written: string[] = [];
    let killed = false;
    const child: PluginChild = {
        write: (line) => {
            written.push(line);
            const steps = script(line);
            void (async () => {
                for (const step of steps) {
                    if (typeof step === 'string') stdout.emit('line', step);
                    else if ('exit' in step) exit.emit('exit', step.exit);
                    else await new Promise((r) => setTimeout(r, step.wait));
                }
            })();
        },
        onLine: (l) => { stdout.on('line', l); },
        onStderr: (l) => { stderr.on('line', l); },
        onExit: (l) => { exit.on('exit', l); },
        kill: () => { killed = true; exit.emit('exit', 137); },
    };
    return { child, written, stderr, wasKilled: () => killed };
}

let launched: LaunchSpec[] = [];
afterEach(() => { launched = []; delete process.env.GENIE_TEST_SECRET; });

describe('runPluginTool', () => {
    it('launches the tool module in its own process with a MINIMAL env, sends the call, relays a declared genie request, and returns the result', async () => {
        process.env.GENIE_TEST_SECRET = 'must-not-leak';
        const api: string[] = [];
        const fake = fakeChild((line) => {
            const msg = JSON.parse(line) as { call?: unknown; reply?: { id: number; result?: unknown } };
            if (msg.call) return [JSON.stringify({ genie: { id: 1, method: 'knowledge.search', params: { query: 'lint rules' } } })];
            if (msg.reply) return [JSON.stringify({ result: { fixed: 3, from: msg.reply.result } }), { exit: 0 }];
            return [];
        });
        const result = await runPluginTool({
            pluginDir: '/plugins/acme.lint',
            tool,
            args: { path: 'src/a.ts' },
            caller,
            guard,
            api: async (method, params) => { api.push(`${method}:${JSON.stringify(params)}`); return ['rule-1']; },
            launch: (spec) => { launched.push(spec); return fake.child; },
            timeoutMs: 5_000,
        });
        expect(result).toEqual({ ok: true, result: { fixed: 3, from: ['rule-1'] } });
        expect(launched).toHaveLength(1);
        expect(launched[0]!.module.replace(/\\/g, '/')).toBe('/plugins/acme.lint/tools/lint.js');
        expect(launched[0]!.process).toBe('subprocess');
        // The environment is MINIMAL: nothing of the user's shell crosses into the plugin.
        expect(Object.keys(launched[0]!.env).sort()).toEqual(['GENIE_PLUGIN_ID', 'GENIE_PLUGIN_TOOL', 'PATH'].sort());
        expect(launched[0]!.env.GENIE_PLUGIN_ID).toBe('acme.lint');
        expect(JSON.stringify(launched[0]!.env)).not.toContain('must-not-leak');
        // The first line is the call, with the caller named (never a secret, never a token).
        expect(JSON.parse(fake.written[0]!)).toEqual({ call: { tool: 'lint', args: { path: 'src/a.ts' }, caller } });
        expect(api).toEqual(['knowledge.search:{"query":"lint rules"}']);
        expect(JSON.parse(fake.written[1]!)).toEqual({ reply: { id: 1, result: ['rule-1'] } });
    });

    it('an UNDECLARED genie request is refused through the guard — the plugin gets the reason, the api is never called', async () => {
        const api: string[] = [];
        const fake = fakeChild((line) => {
            const msg = JSON.parse(line) as { call?: unknown; reply?: { id: number; error?: string } };
            if (msg.call) return [JSON.stringify({ genie: { id: 7, method: 'inbox.send', params: {} } })];
            if (msg.reply) return [JSON.stringify({ result: { sawError: msg.reply.error } }), { exit: 0 }];
            return [];
        });
        const result = await runPluginTool({ pluginDir: '/plugins/acme.lint', tool, args: {}, caller, guard, api: async (m) => { api.push(m); return null; }, launch: () => fake.child, timeoutMs: 5_000 });
        expect(api).toEqual([]);
        expect(result.ok).toBe(true);
        expect((result as { result: { sawError: string } }).result.sawError).toMatch(/did not declare genieApi "inbox.send"/);
    });

    it('a crash before a result is an error with the exit code and the stderr tail; garbage is an error; a timeout kills the child', async () => {
        // The child writes to stderr, THEN dies: the exit must come after the test has emitted the line.
        const crash = fakeChild((line) => (JSON.parse(line).call ? [{ wait: 5 }, { exit: 2 }] : []));
        const p = runPluginTool({ pluginDir: '/plugins/acme.lint', tool, args: {}, caller, guard, api: async () => null, launch: () => crash.child, timeoutMs: 5_000 });
        crash.stderr.emit('line', 'TypeError: boom');
        const crashed = await p;
        expect(crashed).toEqual({ ok: false, reason: 'acme.lint.lint exited with code 2 before answering: TypeError: boom' });

        const garbage = fakeChild((line) => (JSON.parse(line).call ? ['not json at all', { exit: 0 }] : []));
        expect(await runPluginTool({ pluginDir: '/plugins/acme.lint', tool, args: {}, caller, guard, api: async () => null, launch: () => garbage.child, timeoutMs: 5_000 })).toEqual({ ok: false, reason: 'acme.lint.lint wrote something that is not a JSON line: not json at all' });

        const silent = fakeChild(() => []);
        const timedOut = await runPluginTool({ pluginDir: '/plugins/acme.lint', tool, args: {}, caller, guard, api: async () => null, launch: () => silent.child, timeoutMs: 30 });
        expect(timedOut).toEqual({ ok: false, reason: 'acme.lint.lint did not answer within 30 ms and was stopped' });
        expect(silent.wasKilled()).toBe(true);
    });
});
