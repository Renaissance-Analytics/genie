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
    trust: 'trusted' | 'unsigned' | 'untrusted';
    dev_approved: boolean;
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
    setPluginPanelOpenSink,
    type PluginToolExecutor,
} from '../registry';
import { ARTBOARD_SOURCE } from '../artboard-plugin';

function helloManifest(namespace = 'hello'): string {
    return JSON.stringify({
        id: 'ai.genie.hello-world',
        namespace,
        name: 'Hello World',
        version: '0.1.0',
        entry: { tools: 'tools.cjs' },
        agent: { guide: 'Use this plugin for greetings.' },
        mcpTools: [
            {
                name: 'greet',
                description: 'Return a greeting.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                run: 'tools',
                process: 'worker',
            },
        ],
        panels: [{
            id: 'board',
            title: 'Board',
            fancyComponent: { package: '@particle-academy/react-fancy', version: '>=0.5.0', export: 'ArtBoardPanel' },
        }],
        capabilities: { fs: { scope: 'none' }, network: { hosts: [] }, genieApi: ['ui.panel'] },
    });
}

function row(over: Partial<PluginRowLike> = {}): PluginRowLike {
    return {
        id: 'ai.genie.hello-world',
        namespace: 'hello',
        name: 'Hello World',
        enabled: true,
        manifest_json: helloManifest(),
        grants: { fs: {}, network: {}, genieApi: { 'ui.panel': true } },
        trust: 'trusted',
        dev_approved: false,
        ...over,
    };
}

afterEach(() => {
    store.rows = [];
    setPluginToolExecutor(null);
    setPluginPanelOpenSink(null);
});

describe('pluginToolDescriptors', () => {
    it('lists an enabled plugin tool, namespaced', () => {
        store.rows = [row()];
        const tools = pluginToolDescriptors();
        expect(tools.map((t) => t.name)).toEqual(['hello.greet']);
        expect(tools[0].description).toContain('Return a greeting.');
        expect(tools[0].description).toContain('Plugin guide:');
        expect(tools[0].description).toContain('Use this plugin for greetings.');
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

    it('TRUST GATE: an untrusted plugin contributes nothing, even enabled', () => {
        store.rows = [row({ trust: 'untrusted' })];
        expect(pluginToolDescriptors()).toEqual([]);
        expect(ownsPluginTool('hello.greet')).toBe(false);
    });

    it('TRUST GATE: an unsigned plugin surfaces ONLY when dev-approved', () => {
        store.rows = [row({ trust: 'unsigned', dev_approved: false })];
        expect(pluginToolDescriptors()).toEqual([]); // not approved → fail-closed
        store.rows = [row({ trust: 'unsigned', dev_approved: true })];
        expect(pluginToolDescriptors().map((t) => t.name)).toEqual(['hello.greet']);
    });
});

describe('dispatchPluginTool', () => {
    it('honours a successful plugin request to open and focus its declared panel', async () => {
        store.rows = [row()];
        const open = vi.fn();
        setPluginPanelOpenSink(open);
        setPluginToolExecutor({
            call: vi.fn().mockResolvedValue({
                content: [{ type: 'text', text: 'Posted.' }],
                _meta: { geniePanel: { panelId: 'board', activeItemId: 'mockup-one' } },
            }),
            dispose: vi.fn(),
        } as unknown as PluginToolExecutor);

        await dispatchPluginTool('hello.greet', {}, 'term-1');

        expect(open).toHaveBeenCalledWith({
            terminalId: 'term-1',
            pluginId: 'ai.genie.hello-world',
            panelId: 'board',
            activeItemId: 'mockup-one',
        });
    });
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

// --- CONTRIBUTING.md "Never report a success you have not verified" ---------
//
// #306 was ArtBoard's tool description promising it "opens and focuses the
// panel" while NOTHING did. The sink is wired now — but a post still only ever
// ASKS. `_meta.geniePanel` is a request that six separate places drop in
// silence, none of them routed back to the caller:
//
//   1. background.ts    — `if (!workspaceId) return`
//   2. registry.ts      — `panelOpenSink` is still null
//   3. registry.ts      — the panel is not `declared` in the manifest
//   4. master.tsx       — `if (!panel || !workspace) return`
//   5. remote/index.ts  — `broadcastLocal` skips remote-bound windows
//   6. remote/index.ts  — a headless host has no windows to broadcast to
//
// So "Genie opened and focused the panel" is a success no post has verified.
// Outcome 2: narrow the claim to what holds in all six cases — it was
// REQUESTED. The two drops below are the positive control: they prove the
// request really can vanish, so the narrowing is not cosmetic.

describe('a panel-open request is dropped SILENTLY', () => {
    function requestingExecutor() {
        return {
            call: vi.fn().mockResolvedValue({
                content: [{ type: 'text', text: 'Posted.' }],
                _meta: { geniePanel: { panelId: 'board' } },
            }),
            dispose: vi.fn(),
        } as unknown as PluginToolExecutor;
    }

    it('drops it when NO sink is registered, and the call still reports success', async () => {
        store.rows = [row()];
        setPluginPanelOpenSink(null);
        setPluginToolExecutor(requestingExecutor());

        const res = await dispatchPluginTool('hello.greet', {}, 'term-1');
        // Nothing opened, nothing failed, and the caller is told nothing.
        expect(res.isError).toBeFalsy();
    });

    it('drops it when the manifest declares no such panel', async () => {
        const noPanels = JSON.parse(helloManifest()) as Record<string, unknown>;
        delete noPanels.panels;
        store.rows = [row({ manifest_json: JSON.stringify(noPanels) })];
        const open = vi.fn();
        setPluginPanelOpenSink(open);
        setPluginToolExecutor(requestingExecutor());

        const res = await dispatchPluginTool('hello.greet', {}, 'term-1');
        expect(open).not.toHaveBeenCalled();
        expect(res.isError).toBeFalsy();
    });
});

describe("ArtBoard's prose claims a REQUEST, not a completed open", () => {
    /** Every place ArtBoard describes the panel: the manifest's agent guide and
     *  its tool description, plus the text the tool hands back to the caller. */
    const manifestProse = () => JSON.stringify(ARTBOARD_SOURCE.manifest);
    const returnProse = () => ARTBOARD_SOURCE.tools;

    it('never says Genie OPENED or FOCUSED the panel', () => {
        for (const prose of [manifestProse(), returnProse()]) {
            expect(prose).not.toMatch(/opened and focused/i);
            expect(prose).not.toMatch(/opens and focuses/i);
        }
    });

    it('says the post REQUESTED the panel — true whichever of the six drops fires', () => {
        expect(returnProse()).toMatch(/requested that Genie surface the ArtBoard panel/i);
        expect(manifestProse()).toMatch(/request/i);
    });

    it('still ASKS: the tool result carries the geniePanel request', () => {
        // Positive control. "It no longer claims to open the panel" would pass
        // just as well if the request had been deleted; it has not been.
        expect(returnProse()).toContain('geniePanel');
        expect(returnProse()).toContain("panelId: 'board'");
    });
});
