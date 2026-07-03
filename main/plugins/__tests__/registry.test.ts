import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Registry-level coverage of the Plugin System MCP seam (§5.1):
 *   - only ENABLED plugins contribute namespaced tool descriptors,
 *   - a malformed manifest snapshot is OMITTED (fail-closed),
 *   - dispatch routes to the injected executor, and
 *   - an unknown tool / a thrown handler are CONTAINED as isError results
 *     (never thrown up into the JSON-RPC transport).
 *
 * The DB is mocked (controlled rows) and the tool EXECUTOR is a fake, so the
 * registry logic is exercised without Electron / a real worker / a real DB.
 */

const store = vi.hoisted(() => ({ rows: [] as PluginRowLike[] }));

interface PluginRowLike {
    id: string;
    namespace: string;
    name: string;
    enabled: boolean;
    manifest_json: string;
    grants: { fs: Record<string, boolean>; network: Record<string, boolean>; genieApi: Record<string, boolean> };
}

vi.mock('../../db', () => ({
    listEnabledPlugins: () => store.rows.filter((r) => r.enabled),
    getPlugin: (id: string) => store.rows.find((r) => r.id === id) ?? null,
}));

import {
    pluginToolDescriptors,
    dispatchPluginTool,
    ownsPluginTool,
    setPluginToolExecutor,
    type PluginToolExecutor,
} from '../registry';

function helloManifest(namespace = 'hello'): string {
    return JSON.stringify({
        id: 'ai.genie.hello-world',
        namespace,
        name: 'Hello World',
        version: '0.1.0',
        entry: { tools: 'tools.cjs' },
        mcpTools: [
            {
                name: 'greet',
                description: 'Return a greeting.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                run: 'tools',
                process: 'worker',
            },
        ],
        capabilities: { fs: { scope: 'none' }, network: { hosts: [] }, genieApi: [] },
    });
}

function row(over: Partial<PluginRowLike> = {}): PluginRowLike {
    return {
        id: 'ai.genie.hello-world',
        namespace: 'hello',
        name: 'Hello World',
        enabled: true,
        manifest_json: helloManifest(),
        grants: { fs: {}, network: {}, genieApi: {} },
        ...over,
    };
}

afterEach(() => {
    store.rows = [];
    setPluginToolExecutor(null);
});

describe('pluginToolDescriptors', () => {
    it('lists an enabled plugin tool, namespaced', () => {
        store.rows = [row()];
        const tools = pluginToolDescriptors();
        expect(tools.map((t) => t.name)).toEqual(['hello.greet']);
        expect(tools[0].description).toBe('Return a greeting.');
    });

    it('contributes nothing when the plugin is DISABLED', () => {
        store.rows = [row({ enabled: false })];
        expect(pluginToolDescriptors()).toEqual([]);
    });

    it('OMITS a plugin whose manifest snapshot is malformed (fail-closed)', () => {
        store.rows = [
            row({ manifest_json: '{ not json' }),
            row({ id: 'other', namespace: 'ok', manifest_json: helloManifest('ok') }),
        ];
        // The good one still lists; the broken one is skipped, not fatal.
        expect(pluginToolDescriptors().map((t) => t.name)).toEqual(['ok.greet']);
    });
});

describe('dispatchPluginTool', () => {
    it('routes a namespaced call to the executor and returns its result', async () => {
        store.rows = [row()];
        const call = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Hello, world!' }] });
        setPluginToolExecutor({ call, dispose: vi.fn() } as unknown as PluginToolExecutor);

        const res = await dispatchPluginTool('hello.greet', { name: 'world' }, 'term-1');
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toBe('Hello, world!');
        // The executor got the resolved plugin + tool + args.
        expect(call).toHaveBeenCalledTimes(1);
        const exec = call.mock.calls[0][0];
        expect(exec.toolName).toBe('greet');
        expect(exec.args).toEqual({ name: 'world' });
        expect(exec.terminalId).toBe('term-1');
    });

    it('returns a CONTAINED error for an unknown namespaced tool (no throw)', async () => {
        store.rows = [row()];
        const res = await dispatchPluginTool('hello.nope', {}, 'term-1');
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain('No enabled plugin provides');
    });

    it('does NOT dispatch to a disabled plugin', async () => {
        store.rows = [row({ enabled: false })];
        const res = await dispatchPluginTool('hello.greet', {}, 'term-1');
        expect(res.isError).toBe(true);
    });

    it('CONTAINS a thrown handler as an isError result (never rejects)', async () => {
        store.rows = [row()];
        setPluginToolExecutor({
            call: vi.fn().mockRejectedValue(new Error('boom')),
            dispose: vi.fn(),
        } as unknown as PluginToolExecutor);

        const res = await dispatchPluginTool('hello.greet', {}, 'term-1');
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain('boom');
    });
});

describe('ownsPluginTool', () => {
    it('is true for an enabled plugin tool and false otherwise', () => {
        store.rows = [row()];
        expect(ownsPluginTool('hello.greet')).toBe(true);
        expect(ownsPluginTool('hello.nope')).toBe(false);
        expect(ownsPluginTool('imDone')).toBe(false);
    });
});
