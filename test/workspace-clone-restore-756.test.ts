import { describe, expect, it } from 'vitest';
import { flowDocument } from '../src/core/flow-form.js';
import { flowsDeclaration } from '../src/core/workspace-flows.js';
import { processesDeclaration } from '../src/core/workspace-processes.js';
import { tabsDeclaration } from '../src/core/workspace-tabs-save.js';
import type { FlowPorts } from '../src/main/workspace-flows-host.js';
import type { ProcessPorts } from '../src/main/workspace-processes-host.js';
import type { RestorePorts } from '../src/main/workspace-restore-host.js';
import { restoreClone, watchNewWorkspaces, type CloneRestorePorts } from '../src/main/workspace-clone-restore-host.js';

/**
 * OPENING A FRESH CLONE, IN ORDER (Tynn #756, PR9a; the owner, 2026-11-16: a fresh clone restores flows disarmed and processes
 * stopped; the person starts them after the workspace's trust). The order: the workspace's SETTINGS first (declarative, no trust),
 * its TABS, then the trust verdict, then FLOWS (disarmed) and PROCESSES (stopped). Nothing that would run anything is created
 * before the trust; nothing the clone already has is overwritten; one step failing never stops the next. Fixtures: invented names.
 */

const WS = { id: 'ws_clone', path: '/c/acme' };
const V5 = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/project.schema.json';
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const nightly = () => flowsDeclaration([{ name: 'Nightly backup', workspaceId: 'w', document: flowDocument({ workspaceId: 'w', cron: '0 3 * * *', step: { kind: 'command', command: 'npm run backup', folder: 'repos/app' } }) as unknown as Record<string, unknown> }], 'w').files[0]!.value;
const quiet = () => flowsDeclaration([{ name: 'Quiet', workspaceId: 'w', document: flowDocument({ workspaceId: 'w', cron: '0 3 * * *', step: { kind: 'log' } }) as unknown as Record<string, unknown> }], 'w').files[0]!.value;
const worker = () => processesDeclaration([{ name: 'Queue worker', workspaceId: 'w', command: 'php artisan queue:work', cwd: '/c/acme/repos/app', restart: 'always' }], 'w', '/c/acme').files[0]!.value;
const nightlyTask = () => processesDeclaration([{ name: 'Nightly dump', workspaceId: 'w', command: 'php artisan db:dump', cwd: '/c/acme', restart: 'never', schedule: { cron: '0 3 * * *', kind: 'command' } }], 'w', '/c/acme').files[0]!.value;
const tabsFile = () => tabsDeclaration({ tabs: JSON.stringify({ tabs: [{ id: 'tab-1', name: 'Work', layout: 'columns-2', cells: [{ kind: 'files', ref: 'repos/app' }, null] }] }), panelSplits: JSON.stringify({ columns: [0.4, 0.6] }), panelLayout: 'columns' }, '/c/acme').files[0]!.value;

interface Rig {
    files?: Record<string, string>;
    trusted?: boolean;
    existingTabs?: string;
    overridden?: Record<string, unknown>;
    flowsOpen?: boolean;
    processesOpen?: boolean;
    boom?: 'tabs' | 'flows';
}
function rig(over: Rig = {}) {
    const log: string[] = [];
    const files: Record<string, string> = over.files ?? {
        '/c/acme/project.json': json({ $schema: V5, name: 'Acme', workspace: { agentCap: 4 } }),
        '/c/acme/.genie/tabs.json': JSON.stringify(tabsFile()),
        '/c/acme/.flows/nightly-backup.json': JSON.stringify(nightly()),
        '/c/acme/.flows/quiet.json': JSON.stringify(quiet()),
        '/c/acme/.processes/queue-worker.json': JSON.stringify(worker()),
        '/c/acme/.processes/nightly-dump.json': JSON.stringify(nightlyTask()),
    };
    const created: { workspaceId: string; name: string; document: unknown; by: unknown }[] = [];
    const kept: { name: string; enabled?: boolean | undefined; schedule?: unknown }[] = [];
    const writes: [string, string][] = [];
    const settings: RestorePorts = {
        agentsOf: () => [], overridden: () => over.overridden ?? {}, setSetting: async (_w, k, v) => { log.push('settings'); void k; void v; },
        defaultAgentOf: () => null, setDefaultAgent: async () => {}, envFileOf: () => null, defaultEnvFile: () => '.env', setEnvFile: async () => {}, mcpOff: () => [], setMcpServer: async () => {},
    };
    const flows: FlowPorts = { list: () => [], create: async (input) => { log.push('flows'); created.push(input); return input; } };
    const processes: ProcessPorts = { list: () => [], keep: async (input) => { log.push('processes'); kept.push(input); return input; }, agentAddressOf: () => null };
    const ports: CloneRestorePorts = {
        files: {
            read: async (p) => files[p] ?? null,
            list: async (dir) => { const names = Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)); if (names.length === 0 && !(dir.endsWith('.flows') || dir.endsWith('.processes') || dir.endsWith('.genie'))) throw new Error('ENOENT'); return names; },
        },
        settings,
        tabs: {
            values: () => ({ tabs: over.existingTabs ?? '', panelSplits: '', panelLayout: '' }),
            overridden: () => over.overridden ?? {},
            write: async (_w, key, value) => { if (over.boom === 'tabs') throw new Error('the settings store is closed'); log.push('tabs'); writes.push([key, value]); },
            siteHosts: () => [],
        },
        flows: async () => (over.flowsOpen === false ? null : flows),
        processes: async () => (over.processesOpen === false ? null : processes),
        trusted: () => { log.push('trust'); return over.trusted === true; },
    };
    if (over.boom === 'flows') ports.flows = async () => { throw new Error('the flow store failed to open'); };
    return { ports, log, created, kept, writes };
}

describe('the order', () => {
    it('settings, then tabs, then the trust verdict, then flows, then processes', async () => {
        const { ports, log } = rig({ trusted: true });
        const out = await restoreClone(WS, ports);
        expect(out.order).toEqual(['settings', 'tabs', 'trust', 'flows', 'processes']);
        expect(log).toEqual(['settings', 'tabs', 'tabs', 'tabs', 'trust', 'flows', 'flows', 'processes', 'processes']);
    });

    it('before the trust: settings and tabs are applied, a log-only flow is created, and everything that would run waits, listed', async () => {
        const { ports, created, kept, writes } = rig({ trusted: false });
        const out = await restoreClone(WS, ports);
        expect(out.trusted).toBe(false);
        expect(out.settings?.applied).toEqual(['agent_cap']);
        expect(writes.map(([k]) => k).sort()).toEqual(['panel_layout', 'panel_splits', 'workspace_tabs']);
        expect(created.map((c) => c.name)).toEqual(['quiet']);
        expect(out.flows?.waiting).toEqual([{ file: '.flows/nightly-backup.json', commands: ['npm run backup'] }]);
        expect(out.processes?.waiting.map((w) => w.file).sort()).toEqual(['.processes/nightly-dump.json', '.processes/queue-worker.json']);
        expect(kept).toEqual([]);
    });

    it('after the trust: every flow is created DISARMED, by the person, for this workspace; every process is kept stopped, a scheduled task paused', async () => {
        const { ports, created, kept } = rig({ trusted: true });
        const out = await restoreClone(WS, ports);
        expect(out.flows?.created.sort()).toEqual(['.flows/nightly-backup.json', '.flows/quiet.json']);
        for (const c of created) { expect(c.workspaceId).toBe('ws_clone'); expect(c.by).toEqual({ kind: 'user' }); expect(c).not.toHaveProperty('armed'); }
        expect(out.processes?.created.sort()).toEqual(['.processes/nightly-dump.json', '.processes/queue-worker.json']);
        expect(kept.find((k) => k.name === 'nightly-dump')).toMatchObject({ enabled: false });
        expect(kept.find((k) => k.name === 'queue-worker')).not.toHaveProperty('enabled');
    });
});

describe('the tabs', () => {
    it('are added where the clone has none, with the splits and the layout; what it already has is left alone', async () => {
        const mine = JSON.stringify({ tabs: [{ id: 'tab-1', name: 'Mine', layout: 'single', cells: [null] }] });
        const { ports, writes } = rig({ trusted: true, existingTabs: mine });
        const out = await restoreClone(WS, ports);
        expect(out.tabs).toMatchObject({ added: [], differs: ['tab-1'] });
        expect(writes.find(([k]) => k === 'workspace_tabs')).toBeUndefined();
        expect(writes.map(([k]) => k).sort()).toEqual(['panel_layout', 'panel_splits']);
    });

    it('a splits value or a layout the person already set is not replaced', async () => {
        const { ports, writes } = rig({ trusted: true, overridden: { panel_splits: '{"columns":[0.5,0.5]}', panel_layout: 'rows' } });
        await restoreClone(WS, ports);
        expect(writes.map(([k]) => k)).toEqual(['workspace_tabs']);
    });
});

describe('what goes wrong', () => {
    it('no project.json, or one that is not JSON: nothing is restored, and it says why', async () => {
        const none = await restoreClone(WS, rig({ files: {} }).ports);
        expect(none.order).toEqual([]);
        expect(none.skipped).toEqual([{ step: 'project.json', reason: 'this workspace has no project.json' }]);
        const broken = await restoreClone(WS, rig({ files: { '/c/acme/project.json': '{ nope' } }).ports);
        expect(broken.order).toEqual([]);
        expect(broken.skipped[0]).toMatchObject({ step: 'project.json' });
        expect(broken.skipped[0]!.reason).toContain('not valid JSON');
    });

    it('a step that fails does not stop the next: the tabs fail, the flows and processes still come', async () => {
        const { ports } = rig({ trusted: true, boom: 'tabs' });
        const out = await restoreClone(WS, ports);
        expect(out.skipped).toEqual([{ step: 'tabs', reason: 'the settings store is closed' }]);
        expect(out.flows?.created).toHaveLength(2);
        expect(out.processes?.created).toHaveLength(2);
    });

    it('a store that is not open yet (the host is still starting) is skipped, said, and the rest go on', async () => {
        const { ports } = rig({ trusted: true, flowsOpen: false, processesOpen: false });
        const out = await restoreClone(WS, ports);
        expect(out.flows).toBeNull();
        expect(out.processes).toBeNull();
        expect(out.skipped.map((s) => s.step)).toEqual(['flows', 'processes']);
        expect(out.settings?.applied).toEqual(['agent_cap']);
    });

    it('a store that fails to open is skipped with its reason', async () => {
        const out = await restoreClone(WS, rig({ trusted: true, boom: 'flows' }).ports);
        expect(out.skipped).toEqual([{ step: 'flows', reason: 'the flow store failed to open' }]);
        expect(out.processes?.created).toHaveLength(2);
    });

    it('CONTROL: a project.json with nothing saved beside it writes and creates nothing', async () => {
        const { ports, log } = rig({ trusted: true, files: { '/c/acme/project.json': json({ $schema: V5, name: 'Acme' }) } });
        const out = await restoreClone(WS, ports);
        expect(log).toEqual(['trust']);
        expect(out.flows).toEqual({ created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] });
        expect(out.processes).toEqual({ created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] });
        expect(out.tabs).toBeNull();
        expect(out.skipped).toEqual([]);
    });

    it('only .json files in .flows and .processes are read, and a file that is not a flow is refused with its place', async () => {
        const { ports, created } = rig({ trusted: true, files: { '/c/acme/project.json': json({ name: 'A' }), '/c/acme/.flows/readme.md': '# hi', '/c/acme/.flows/quiet.json': JSON.stringify(quiet()), '/c/acme/.flows/broken.json': '{ nope' } });
        const out = await restoreClone(WS, ports);
        expect(created.map((c) => c.name)).toEqual(['quiet']);
        expect(out.flows?.refused.map((r) => r.file)).toEqual(['.flows/broken.json']);
    });
});

describe('a workspace that appears', () => {
    it('is noticed once, and only if it was not there when watching began', () => {
        const heard: string[] = [];
        let listener: (() => void) | null = null;
        let roster = [{ id: 'old', asleep: false }];
        watchNewWorkspaces({ workspaceStates: () => roster, subscribe: (l) => { listener = l; return () => {}; } }, (id) => heard.push(id));
        listener!();
        expect(heard).toEqual([]);
        roster = [...roster, { id: 'fresh', asleep: false }];
        listener!();
        listener!();
        expect(heard).toEqual(['fresh']);
    });

    it('a hibernated workspace that shows up is not restored into', () => {
        const heard: string[] = [];
        let listener: (() => void) | null = null;
        let roster: { id: string; asleep: boolean }[] = [];
        watchNewWorkspaces({ workspaceStates: () => roster, subscribe: (l) => { listener = l; return () => {}; } }, (id) => heard.push(id));
        roster = [{ id: 'ghost', asleep: true }];
        listener!();
        expect(heard).toEqual([]);
    });
});
