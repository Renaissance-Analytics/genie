import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importedAgents } from '../src/core/agent-adoption.js';
import { adoptAgent, readImportedAgents, type AgentAdoptionPorts } from '../src/main/agent-adoption-host.js';
import { deleteAgent, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { AgentRosterView } from '../src/renderer/components/ImportedAgents.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * REATTACH (agent management parity item 2; the owner, 2026-10-21: "...or detach it (so its files remain but it's not loaded
 * into Genie), or reattach an agent that was detached"). Genie 1's workspace roster (main/agents/roster.ts,
 * WorkspaceSettingsModal's WorkspaceAgentRoster / AgentRosterList): the agents REGISTERED here, and the ones ON DISK ONLY —
 * an `.agents/<name>/AGENT.md` with no registration — each with a way back, or the reason there is none.
 *
 * Unmount forgets the record and keeps the files; until now the only way back was the offer right after an add, so once
 * unmounted an agent stayed out. The roster sits in the workspace's Settings, reachable any time, and reattaching is
 * adoption — the same rules (reserved names, the name's shape, no duplicates, a runnable `tuis:`), the file read, never
 * rewritten.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-reattach-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const PERSONA = '---\nname: atlas\ntuis: [codex]\n---\n\n# Atlas\n\nKeeps the maps.\n';

/** The ports main.ts passes, over a real registry and a real folder. */
function hostPorts(registry: Registry): { adoption: AgentAdoptionPorts; ops: AgentOpsPorts } {
    const adoption: AgentAdoptionPorts = {
        workspace: (id) => registry.workspace(id),
        agentsOf: (id) => registry.agentsOf(id),
        listDirs: async (d) => (await readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name),
        readText: async (p) => { try { return await readFile(p, 'utf8'); } catch { return null; } },
        register: async (input) => { const r = await registry.register(input); return { id: r.id, name: r.name }; },
    };
    const removed: string[] = [];
    const ops = {
        registry: { find: (id: string) => registry.agentsOf('acme').find((a) => a.id === id) ?? null, forget: (id: never) => registry.forget(id) },
        host: { start: () => ({ ok: true }), stop: () => true, probe: () => null },
        cwdFor: () => join(dir, 'acme'),
        workspacePathFor: () => join(dir, 'acme'),
        readManifest: async () => null,
        removeDir: async (p: string) => { removed.push(p); },
        removeHandoff: async () => {},
        linkedSystems: () => [],
        providerInstalled: () => true,
        signedIn: () => true,
    } as unknown as AgentOpsPorts;
    return { adoption, ops };
}

describe('unmount, then reattach (host, a real registry and a real folder)', () => {
    it('an unmounted agent is listed on disk; Reattach registers it again under the same name, its files untouched', async () => {
        const ws = join(dir, 'acme');
        await mkdir(join(ws, '.agents', 'atlas'), { recursive: true });
        await mkdir(join(ws, '.agents', '_genie'), { recursive: true });
        const file = join(ws, '.agents', 'atlas', 'AGENT.md');
        await writeFile(file, PERSONA, 'utf8');
        const registry = new Registry(new Store(join(dir, 'home')));
        await registry.load({ name: 'test', healthy: true });
        await registry.addWorkspace({ id: 'acme', path: ws });
        const first = await registry.register({ workspaceId: 'acme', provider: 'codex', name: 'atlas', instructions: '.agents/atlas/AGENT.md' });
        const { adoption, ops } = hostPorts(registry);

        // While registered, nothing is on disk only.
        expect(await readImportedAgents(adoption, 'acme')).toEqual({ ok: true, agents: [] });
        const before = { text: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs };

        expect(await deleteAgent(ops, first.id, 'unmount', [])).toMatchObject({ ok: true });
        expect(registry.agentsOf('acme')).toEqual([]);

        // On disk, not in Genie — with what it would come back as.
        expect(await readImportedAgents(adoption, 'acme')).toEqual({ ok: true, agents: [{ name: 'atlas', provider: 'codex', instructions: '.agents/atlas/AGENT.md', refusal: null }] });

        const back = await adoptAgent(adoption, 'acme', 'atlas');
        expect(back).toMatchObject({ ok: true, name: 'atlas' });
        expect(registry.agentsOf('acme').map((a) => ({ name: a.name, provider: a.provider, instructions: a.instructions }))).toEqual([{ name: 'atlas', provider: 'codex', instructions: '.agents/atlas/AGENT.md' }]);
        expect(await readImportedAgents(adoption, 'acme')).toEqual({ ok: true, agents: [] });
        // The file is the thing a person is afraid for: same bytes, never rewritten.
        expect(await readFile(file, 'utf8')).toBe(before.text);
        expect((await stat(file)).mtimeMs).toBe(before.mtime);
    });
});

type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const props = node.props as Props;
    if (match(props)) out.push(props);
    findAll(props.children, match, out);
    return out;
}
const noop = () => {};
const onDisk = importedAgents({ files: [{ folder: 'atlas', text: PERSONA }, { folder: 'tynn', text: '' }], registered: [{ name: 'bolt' }] });
const roster = { registered: [{ id: 'agent_b', name: 'bolt', provider: 'claude' }], onDisk, busy: null, notice: null, error: null, onReattach: noop };

describe('the workspace’s agent roster (Genie 1’s Registered / On disk only)', () => {
    it('lists the registered agents and the ones on disk only, a Reattach for each Genie can take (COUNTED: one)', () => {
        const html = renderToStaticMarkup(<AgentRosterView {...roster} />);
        expect(html).toMatch(/data-roster-registered=""[\s\S]*?data-roster-agent="bolt"/);
        expect(html).toMatch(/data-roster-on-disk=""[\s\S]*?data-imported-agent="atlas"[\s\S]*?codex/);
        expect(html.match(/data-action="reattach-agent"/g)?.length).toBe(1);
        expect(html).toContain('data-agent="atlas"');
        // A refused file is shown with its reason and no Reattach.
        expect(html).toMatch(/data-imported-agent="tynn"[\s\S]*?reserved name/);
        expect(html).not.toMatch(/data-action="reattach-agent"[^>]*data-agent="tynn"/);
        // Never an Adopt here: one verb per screen.
        expect(html).not.toContain('data-action="adopt-agent"');
    });

    it('Reattach reattaches THAT agent; while it runs every Reattach waits; the result and errors are shown', () => {
        const did: string[] = [];
        const ui = AgentRosterView({ ...roster, onReattach: (n) => did.push(n) });
        for (const b of findAll(ui, (p) => p['data-action'] === 'reattach-agent')) (b.onClick as () => void)();
        expect(did).toEqual(['atlas']);
        const busy = renderToStaticMarkup(<AgentRosterView {...roster} busy="atlas" notice="atlas is registered." error="acme already has an agent named atlas" />);
        expect(busy).toMatch(/data-agent="atlas"[^>]*disabled=""/);
        expect(busy).toContain('atlas is registered.');
        expect(busy).toContain('acme already has an agent named atlas');
    });

    it('nothing on disk only says so; a list not read yet is not shown as empty', () => {
        expect(renderToStaticMarkup(<AgentRosterView {...roster} onDisk={[]} />)).toContain('data-roster-on-disk-empty=""');
        const loading = renderToStaticMarkup(<AgentRosterView {...roster} onDisk={null} />);
        expect(loading).not.toContain('data-roster-on-disk-empty=""');
        expect(loading).toContain('data-roster-on-disk-loading=""');
    });

    it('it is a card on the workspace’s Settings page, after General; no roster offered = no card', () => {
        const ops = {
            asleep: false, agentCount: 1, removePreview: false, lastOutcome: null,
            onHibernate: noop, onWake: noop, onPreviewRemove: noop, onConfirmRemove: noop, onCancelRemove: noop,
            settings: { values: {}, overridden: [], onSet: noop, onReset: noop },
            agentRoster: roster,
        } as WorkspaceOpsProps;
        const render = (o: WorkspaceOpsProps) => renderToStaticMarkup(<Workspace view="settings" workspace={{ id: 'acme', name: 'acme', path: '/w/acme' }} terminals={NO_TERMINALS} ops={o} />);
        const cards = [...render(ops).matchAll(/data-ws-card="([a-z-]+)"/g)].map((m) => m[1]);
        expect(cards).toEqual(['general', 'agents']);
        expect(render(ops)).toMatch(/data-ws-card="agents"[\s\S]*?data-action="reattach-agent"/);
        // CONTROL: the same page without the roster has no card.
        const { agentRoster: _gone, ...without } = ops;
        expect(render(without as WorkspaceOpsProps)).not.toContain('data-ws-card="agents"');
    });
});
