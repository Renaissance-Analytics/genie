import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An ArtBoard post waiting for a verdict raises an alert (genie#546).
 *
 * ArtBoard is the one surface in Genie where an agent hands a person something
 * and then STOPS — the verdict is the whole point, and the agent gets it back as
 * a message. A post sitting unseen is the agent blocked on you without saying
 * so, which is precisely the shape the imDone and ForceTheQuestion chimes
 * already exist for.
 *
 * ## Why the plugin id is checked and not just "any panel-open request"
 *
 * `_meta.geniePanel` is generic plugin machinery: any plugin can ask Genie to
 * surface its panel, for any reason. Chiming "something is waiting for your
 * review" at all of them would be the alert describing something it did not
 * check. So the ArtBoard id gates it, and a second plugin gets its own decision
 * when there is one to make.
 */

const store = vi.hoisted(() => ({ rows: [] as PluginRowLike[] }));

interface PluginRowLike {
    id: string;
    namespace: string;
    name: string;
    enabled: boolean;
    manifest_json: string;
    grants: {
        fs: Record<string, boolean>;
        network: Record<string, boolean>;
        genieApi: Record<string, boolean>;
    };
    trust: 'trusted' | 'unsigned' | 'untrusted';
    dev_approved: boolean;
}

vi.mock('../../db', () => ({
    listEnabledPlugins: () => store.rows.filter((r) => r.enabled),
    getPlugin: (id: string) => store.rows.find((r) => r.id === id) ?? null,
}));

const alerts = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock('../../notify-sound', () => ({
    playAlert: (kind: string) => {
        alerts.played.push(kind);
        return true;
    },
}));

import {
    dispatchPluginTool,
    setPluginToolExecutor,
    setPluginPanelOpenSink,
    type PluginToolExecutor,
} from '../registry';
import { ARTBOARD_PLUGIN_ID } from '../artboard-plugin';

function manifest(id: string, namespace: string): string {
    return JSON.stringify({
        id,
        namespace,
        name: 'Panel plugin',
        version: '0.1.0',
        entry: { tools: 'tools.cjs' },
        agent: { guide: 'Posts things.' },
        mcpTools: [
            {
                name: 'post',
                description: 'Post something.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                run: 'tools',
                process: 'worker',
            },
        ],
        panels: [
            {
                id: 'board',
                title: 'Board',
                fancyComponent: {
                    package: '@particle-academy/react-fancy',
                    version: '>=0.5.0',
                    export: 'ArtBoardPanel',
                },
            },
        ],
        capabilities: { fs: { scope: 'none' }, network: { hosts: [] }, genieApi: ['ui.panel'] },
    });
}

function row(id: string, namespace: string): PluginRowLike {
    return {
        id,
        namespace,
        name: 'Panel plugin',
        enabled: true,
        manifest_json: manifest(id, namespace),
        grants: { fs: {}, network: {}, genieApi: { 'ui.panel': true } },
        trust: 'trusted',
        dev_approved: false,
    };
}

/** An executor whose tool result ASKS Genie to surface a panel. */
function requestingExecutor(): PluginToolExecutor {
    return {
        call: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Posted.' }],
            _meta: { geniePanel: { panelId: 'board' } },
        }),
        dispose: vi.fn(),
    } as unknown as PluginToolExecutor;
}

beforeEach(() => {
    alerts.played.length = 0;
    setPluginPanelOpenSink(vi.fn());
    setPluginToolExecutor(requestingExecutor());
});

afterEach(() => {
    store.rows = [];
    setPluginToolExecutor(null);
    setPluginPanelOpenSink(null);
});

describe('an ArtBoard post', () => {
    it('raises reviewRequest', async () => {
        store.rows = [row(ARTBOARD_PLUGIN_ID, 'artboard')];
        await dispatchPluginTool('artboard.post', {}, 'term-1');
        expect(alerts.played).toEqual(['reviewRequest']);
    });
});

describe('what does NOT raise it', () => {
    it('stays silent for another plugin asking for its own panel', () => {
        // The alert says "waiting for your REVIEW". Firing it for any plugin
        // surfacing any panel would make it say something nobody checked.
        store.rows = [row('ai.example.other', 'other')];
        return dispatchPluginTool('other.post', {}, 'term-1').then(() => {
            expect(alerts.played).toEqual([]);
        });
    });

    it('POSITIVE CONTROL: the same tool call from ArtBoard DOES chime', async () => {
        // Without this, a wiring that never fired would pass the test above.
        store.rows = [row('ai.example.other', 'other')];
        await dispatchPluginTool('other.post', {}, 'term-1');
        store.rows = [row(ARTBOARD_PLUGIN_ID, 'artboard')];
        await dispatchPluginTool('artboard.post', {}, 'term-1');
        expect(alerts.played).toEqual(['reviewRequest']);
    });

    it('stays silent when the post did not ask for a panel at all', async () => {
        store.rows = [row(ARTBOARD_PLUGIN_ID, 'artboard')];
        setPluginToolExecutor({
            call: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
            dispose: vi.fn(),
        } as unknown as PluginToolExecutor);
        await dispatchPluginTool('artboard.post', {}, 'term-1');
        expect(alerts.played).toEqual([]);
    });

    it('stays silent when the tool call FAILED', async () => {
        // Nothing was posted, so nothing is waiting to be reviewed.
        store.rows = [row(ARTBOARD_PLUGIN_ID, 'artboard')];
        setPluginToolExecutor({
            call: vi.fn().mockRejectedValue(new Error('boom')),
            dispose: vi.fn(),
        } as unknown as PluginToolExecutor);
        await dispatchPluginTool('artboard.post', {}, 'term-1');
        expect(alerts.played).toEqual([]);
    });

    it('stays silent when the manifest declares no such panel', async () => {
        // One of the six documented drops. If the panel cannot be surfaced,
        // announcing that it is waiting for you would be a lie about what
        // happened — and the request itself is dropped in silence.
        const noPanels = JSON.parse(manifest(ARTBOARD_PLUGIN_ID, 'artboard')) as Record<
            string,
            unknown
        >;
        delete noPanels.panels;
        store.rows = [
            { ...row(ARTBOARD_PLUGIN_ID, 'artboard'), manifest_json: JSON.stringify(noPanels) },
        ];
        await dispatchPluginTool('artboard.post', {}, 'term-1');
        expect(alerts.played).toEqual([]);
    });
});
