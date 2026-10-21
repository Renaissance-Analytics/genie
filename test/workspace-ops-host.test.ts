import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import type { LiveSession } from '../src/core/roster.js';
import { addWorkspace, createWorkspace, hibernateWorkspace, previewAddWorkspace, removeWorkspace, startRefusal, wakeWorkspace, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';

/**
 * WORKSPACE OPERATIONS IN THE APP (§6.1) — the main-process half over the pure plans in
 * core/workspace-model. Adding a folder is PREVIEWED (classified, the plan shown) before anything is
 * written; the write produces a real envelope manifest (the published shared-schemas URL, never an
 * invented one) and refuses to touch a manifest that declares a NEWER schema. Hibernate asks every
 * running agent for a handoff with a bounded wait, marks the workspace asleep (so nothing may start),
 * stops agents, terminals and processes. Remove forgets the workspace and its agents and NEVER
 * touches the folder. Every port is injected.
 */

const SCHEMA = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.2.0/schemas/workspace/project.schema.json';
const rec = (id: string, workspaceId: string, name: string): AgentRecord => ({ id, workspaceId, provider: 'claude', name, instructions: null, threadId: null, createdAt: 't', lastUsedAt: null, mode: 'manual', accessScope: 'self' }) as unknown as AgentRecord;

function fakes(over: { entries?: Record<string, string[]>; files?: Record<string, unknown>; running?: string[]; handoffAfterMs?: number } = {}) {
    const entries = over.entries ?? {};
    const files: Record<string, unknown> = { ...(over.files ?? {}) };
    const calls: string[] = [];
    const workspaces = new Map<string, { id: string; path: string; asleep: boolean }>([['tynn', { id: 'tynn', path: '/w/tynn', asleep: false }]]);
    let agents: AgentRecord[] = [rec('agent_a', 'tynn', 'atlas'), rec('agent_b', 'tynn', 'bolt'), rec('agent_c', 'fancy', 'cass')];
    let now = 1_000;
    const finished: Array<{ id: string; agentId: string; handoff: string | null; at: string; seen: boolean; agentName: string | null }> = [];
    // The host joins paths with the OS's separator (backslashes on Windows); this in-memory fs keys by the posix form.
    const key = (p: string) => p.replace(/\\/g, '/');
    const ports: WorkspaceOpsPorts = {
        fs: {
            exists: async (p) => key(p) in entries,
            entries: async (p) => entries[key(p)] ?? [],
            readJson: async (p) => files[key(p)] ?? null,
            writeJson: async (p, v) => { calls.push(`writeJson:${key(p)}`); files[key(p)] = v; },
            // A folder made exists afterwards, empty (createWorkspace makes the target, then adds it).
            mkdir: async (p) => { calls.push(`mkdir:${key(p)}`); if (!(key(p) in entries)) entries[key(p)] = []; },
            gitInit: async (p) => { calls.push(`gitInit:${key(p)}`); },
            gitClone: async (url, into) => { calls.push(`gitClone:${url}:${key(into)}`); },
        },
        registry: {
            workspace: (id) => workspaces.get(id) ?? null,
            addWorkspace: async (w) => { calls.push(`addWorkspace:${w.id}:${w.path}`); workspaces.set(w.id, { ...w, asleep: false }); },
            agentsOf: (id) => agents.filter((a) => a.workspaceId === id),
            setAsleep: async (id, asleep) => { const w = workspaces.get(id); if (!w) return false; w.asleep = asleep; calls.push(`asleep:${id}:${asleep}`); return true; },
            forgetWorkspace: async (id) => { if (!workspaces.has(id)) return null; const n = agents.filter((a) => a.workspaceId === id).length; agents = agents.filter((a) => a.workspaceId !== id); workspaces.delete(id); calls.push(`forgetWorkspace:${id}`); return { agentsForgotten: n }; },
        },
        host: {
            probe: (id) => ((over.running ?? []).includes(id) ? ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null } as unknown as LiveSession) : null),
            prompt: (id, text) => { calls.push(`prompt:${id}:${text.slice(0, 24)}`); return true; },
            stop: (id) => { calls.push(`stop:${id}`); return true; },
        },
        attention: { finished: () => finished },
        terminals: { list: () => [{ id: 'term_1', workspaceId: 'tynn' }, { id: 'term_2', workspaceId: 'fancy' }], close: (id) => { calls.push(`closeTerminal:${id}`); return true; } },
        supervisor: { list: () => [{ id: 'proc_1', workspaceId: 'tynn' }], stop: (id) => { calls.push(`stopProcess:${id}`); return true; } },
        now: () => now,
        sleep: async (ms) => {
            now += ms;
            // A handoff lands after the configured delay — or never.
            if (over.handoffAfterMs !== undefined && now >= 1_000 + over.handoffAfterMs) {
                for (const id of over.running ?? []) if (!finished.some((f) => f.agentId === id)) finished.push({ id: `fin_${id}`, agentId: id, agentName: null, handoff: 'carry on', at: new Date(now).toISOString(), seen: false });
            }
        },
    };
    return { ports, calls, files, workspaces: () => [...workspaces.values()], agents: () => agents };
}

describe('adding a workspace', () => {
    it('previews: an empty folder, a simple repo, a pre-init folder and a full envelope each get their plan; a missing or unknowable folder is refused', async () => {
        const f = fakes({ entries: { '/w/empty': [], '/w/repo': ['.git', 'src'], '/w/pre': ['repos'], '/w/env': ['project.json', 'repos', '.ai'], '/w/other': ['notes.txt'] } });
        expect(await previewAddWorkspace(f.ports, '/w/empty')).toMatchObject({ ok: true, kind: 'empty', steps: expect.arrayContaining([expect.objectContaining({ action: 'git init' })]) });
        expect(await previewAddWorkspace(f.ports, '/w/repo')).toMatchObject({ ok: true, kind: 'simple-repo' });
        expect(await previewAddWorkspace(f.ports, '/w/pre')).toMatchObject({ ok: true, kind: 'pre-init' });
        expect(await previewAddWorkspace(f.ports, '/w/env')).toMatchObject({ ok: true, kind: 'full-envelope' });
        expect(await previewAddWorkspace(f.ports, '/w/none')).toEqual({ ok: false, reason: '/w/none does not exist; pick a folder that does' });
        // Changed 2026-10-21 (the owner: "Look at Genie 1"): a PLAIN folder is a workspace too, as Genie 1's "Plain folder
        // … Genie can still make a workspace here" — wrapped, never git-inited, nothing of its own touched.
        expect(await previewAddWorkspace(f.ports, '/w/other')).toMatchObject({ ok: true, kind: 'other', steps: expect.not.arrayContaining([expect.objectContaining({ action: 'git init' })]) });
        expect(f.calls).toEqual([]);
    });

    it('a simple repo gets a REAL envelope manifest — the published schema URL, this folder as the host repo — and the scratch dirs; then it is registered', async () => {
        const f = fakes({ entries: { '/w/repo': ['.git', 'src'] } });
        expect(await addWorkspace(f.ports, '/w/repo')).toMatchObject({ ok: true, id: 'repo', kind: 'simple-repo' });
        expect(f.files['/w/repo/project.json']).toMatchObject({ $schema: SCHEMA, name: 'repo', type: 'agi', repos: [{ name: 'repo', slug: 'repo', path: '.' }] });
        expect(f.calls).toEqual(expect.arrayContaining(['mkdir:/w/repo/.ai', 'mkdir:/w/repo/sandbox', 'mkdir:/w/repo/.trash', 'writeJson:/w/repo/project.json', 'addWorkspace:repo:/w/repo']));
        expect(f.calls).not.toContain('gitInit:/w/repo');
        expect(f.calls.indexOf('writeJson:/w/repo/project.json')).toBeLessThan(f.calls.indexOf('addWorkspace:repo:/w/repo'));
    });

    it('an empty folder is also git-initialised; a full envelope is stamped with a backup when older, left alone when current, and REFUSED when newer', async () => {
        const empty = fakes({ entries: { '/w/new': [] } });
        await addWorkspace(empty.ports, '/w/new');
        expect(empty.calls).toContain('gitInit:/w/new');

        const older = fakes({ entries: { '/w/env': ['project.json', 'repos', '.ai'] }, files: { '/w/env/project.json': { $schema: 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.1.0/schemas/workspace/project.schema.json', name: 'Env' } } });
        expect(await addWorkspace(older.ports, '/w/env')).toMatchObject({ ok: true, kind: 'full-envelope', stamped: { from: '0.1.0', backup: 'project.json.pre-schema-0.2.0.bak' } });
        expect(older.files['/w/env/project.json']).toMatchObject({ $schema: SCHEMA, name: 'Env' });
        expect(older.files['/w/env/project.json.pre-schema-0.2.0.bak']).toMatchObject({ name: 'Env' });

        const current = fakes({ entries: { '/w/env': ['project.json', 'repos', '.ai'] }, files: { '/w/env/project.json': { $schema: SCHEMA, name: 'Env' } } });
        expect(await addWorkspace(current.ports, '/w/env')).toMatchObject({ ok: true, stamped: null });
        expect(current.calls.filter((c) => c.startsWith('writeJson'))).toEqual([]);

        const newer = fakes({ entries: { '/w/env': ['project.json', 'repos', '.ai'] }, files: { '/w/env/project.json': { $schema: 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.3.0/schemas/workspace/project.schema.json', name: 'Env' } } });
        expect(await addWorkspace(newer.ports, '/w/env')).toEqual({ ok: false, reason: 'project.json declares schema 0.3.0, newer than the 0.2.0 this Genie writes; not touching it' });
        expect(newer.calls).toEqual([]);
    });
});

/**
 * A NEW WORKSPACE, AS GENIE 1 MADE ONE (the owner, 2026-10-21: "WTf happened to my fucking new workspace UX … Look at
 * Genie 1 … I can't create workspaces at all right now"). Genie 1 asked for a NAME and a FOLDER (prefilled from Settings
 * → Primary workspace) and made `<folder>/<slug>.agi` itself — mkdir, the envelope, git init. Genie 2 could only adopt a
 * folder that already existed and was empty, and its picker could not make one. Refusals come BEFORE any write.
 */
describe('creating a new workspace', () => {
    it('makes <parent>/<slug>.agi, writes the envelope named as typed, git-inits it and registers it', async () => {
        const f = fakes({ entries: { '/w': ['tynn'] } });
        const r = await createWorkspace(f.ports, 'Acme Storefront', '/w');
        expect(r).toMatchObject({ ok: true, id: 'acme-storefront', path: expect.stringMatching(/[\\/]w[\\/]acme-storefront\.agi$/) });
        expect(f.calls[0]).toBe('mkdir:/w/acme-storefront.agi');
        expect(f.calls).toContain('gitInit:/w/acme-storefront.agi');
        expect(f.calls.at(-1)).toMatch(/^addWorkspace:acme-storefront:.*acme-storefront\.agi$/);
        expect(f.files['/w/acme-storefront.agi/project.json']).toMatchObject({ name: 'Acme Storefront', $schema: SCHEMA });
    });

    it('linked to a Tynn project (optional, as in Genie 1): project.json carries `tynn` from TYNN’s own list, not the window’s', async () => {
        const f = fakes({ entries: { '/w': [] } });
        f.ports.tynn = { host: 'https://tynn.example/', projects: async () => [{ id: 42, name: 'Acme', slug: 'acme', vision: null }] };
        const r = await createWorkspace(f.ports, 'Acme Storefront', '/w', '42');
        expect(r).toMatchObject({ ok: true, id: 'acme-storefront' });
        expect(f.files['/w/acme-storefront.agi/project.json']).toMatchObject({ name: 'Acme Storefront', tynn: { host: 'https://tynn.example', project: 'acme', projectId: '42' } });
    });

    it('a project Tynn does not list for you, or no Tynn client: refused in words BEFORE anything is written', async () => {
        const f = fakes({ entries: { '/w': [] } });
        f.ports.tynn = { host: 'https://tynn.example', projects: async () => [{ id: 42, name: 'Acme', slug: 'acme', vision: null }] };
        expect(await createWorkspace(f.ports, 'acme', '/w', '99')).toMatchObject({ ok: false, reason: expect.stringMatching(/Tynn lists no project 99/) });
        f.ports.tynn = undefined;
        expect(await createWorkspace(f.ports, 'acme', '/w', '42')).toMatchObject({ ok: false, reason: expect.stringMatching(/no Tynn client/) });
        expect(f.calls.filter((c) => c.startsWith('mkdir') || c.startsWith('writeJson'))).toEqual([]);
    });

    it('CONTROL: no project chosen — no `tynn` key, as before', async () => {
        const f = fakes({ entries: { '/w': [] } });
        await createWorkspace(f.ports, 'acme', '/w');
        expect(f.files['/w/acme.agi/project.json']).not.toHaveProperty('tynn');
    });

    it('an EMPTY folder of that name already there is used, not refused', async () => {
        const f = fakes({ entries: { '/w': ['acme.agi'], '/w/acme.agi': [] } });
        expect(await createWorkspace(f.ports, 'acme', '/w')).toMatchObject({ ok: true, id: 'acme' });
    });

    it('refuses, BEFORE writing anything: no name, no folder, a name it cannot make a folder of, a folder not empty, a missing parent, a name already taken', async () => {
        const f = fakes({ entries: { '/w': ['acme.agi'], '/w/acme.agi': ['notes.txt'] } });
        expect(await createWorkspace(f.ports, '  ', '/w')).toEqual({ ok: false, reason: 'Give the workspace a name.' });
        expect(await createWorkspace(f.ports, 'acme', ' ')).toEqual({ ok: false, reason: 'Choose where the workspace should live.' });
        expect(await createWorkspace(f.ports, '!!!', '/w')).toEqual({ ok: false, reason: 'Give the workspace a name it can be a folder for.' });
        expect(await createWorkspace(f.ports, 'acme', '/w')).toMatchObject({ ok: false, reason: expect.stringMatching(/acme\.agi is not empty/) });
        expect(await createWorkspace(f.ports, 'acme', '/nowhere')).toMatchObject({ ok: false, reason: expect.stringMatching(/\/nowhere does not exist/) });
        // `tynn` is registered already (the fakes'): a second one of that id is refused, not silently dropped after the writes.
        expect(await createWorkspace(f.ports, 'tynn', '/w')).toMatchObject({ ok: false, reason: expect.stringMatching(/already a workspace named tynn/) });
        expect(f.calls).toEqual([]);
    });
});

describe('adding a folder you already have', () => {
    it('a folder whose name is already a workspace is refused BEFORE anything is written (it was scaffolded, then silently not registered)', async () => {
        const f = fakes({ entries: { '/elsewhere/tynn': [] } });
        expect(await addWorkspace(f.ports, '/elsewhere/tynn')).toMatchObject({ ok: false, reason: expect.stringMatching(/already a workspace named tynn/) });
        expect(f.calls).toEqual([]);
    });

    it('a plain folder is wrapped (no repos/, no git init) and registered', async () => {
        const f = fakes({ entries: { '/w/notes': ['todo.md'] } });
        expect(await addWorkspace(f.ports, '/w/notes')).toMatchObject({ ok: true, id: 'notes', kind: 'other' });
        expect(f.calls.some((c) => c.startsWith('gitInit:'))).toBe(false);
        expect(f.calls).toContain('mkdir:/w/notes/.ai');
        expect(f.calls).not.toContain('mkdir:/w/notes/repos');
    });

    it('a whole drive or the filesystem root is never made a workspace', async () => {
        const f = fakes({ entries: { 'C:/': ['Users', 'Windows'], '/': ['home', 'etc'] } });
        expect(await previewAddWorkspace(f.ports, 'C:\\')).toMatchObject({ ok: false, reason: expect.stringMatching(/a whole drive/) });
        expect(await previewAddWorkspace(f.ports, '/')).toMatchObject({ ok: false, reason: expect.stringMatching(/a whole drive/) });
        expect(f.calls).toEqual([]);
    });
});

describe('hibernate, wake, start refusal', () => {
    it('asks every RUNNING agent for a handoff, waits (bounded) until they land, marks asleep, then stops agents, closes terminals, stops processes — in that order', async () => {
        const f = fakes({ running: ['agent_a'], handoffAfterMs: 400 });
        const r = await hibernateWorkspace(f.ports, 'tynn', { handoffWaitMs: 2_000, pollMs: 200 });
        expect(r).toMatchObject({ ok: true, handoffs: { landed: ['agent_a'], missing: [] }, asleep: true });
        expect(f.calls).toEqual([
            expect.stringMatching(/^prompt:agent_a:/),
            'asleep:tynn:true',
            'stop:agent_a',
            'closeTerminal:term_1',
            'stopProcess:proc_1',
        ]);
        expect(f.workspaces().find((w) => w.id === 'tynn')?.asleep).toBe(true);
    });

    it('a quiet agent does not hold the shutdown forever: after the wait it is listed as missing and stopped anyway', async () => {
        const f = fakes({ running: ['agent_a', 'agent_b'], handoffAfterMs: 99_999 });
        const r = await hibernateWorkspace(f.ports, 'tynn', { handoffWaitMs: 600, pollMs: 200 });
        expect(r).toMatchObject({ ok: true, handoffs: { landed: [], missing: ['agent_a', 'agent_b'] } });
        expect(f.calls.filter((c) => c.startsWith('stop:'))).toEqual(['stop:agent_a', 'stop:agent_b']);
    });

    it('while asleep a start is refused by name; wake clears it; an unknown workspace is refused', async () => {
        const f = fakes({ running: [] });
        await hibernateWorkspace(f.ports, 'tynn', { handoffWaitMs: 100, pollMs: 50 });
        expect(startRefusal(f.ports, rec('agent_a', 'tynn', 'atlas'))).toBe('tynn is hibernating; wake it before starting atlas');
        expect(await wakeWorkspace(f.ports, 'tynn')).toEqual({ ok: true });
        expect(startRefusal(f.ports, rec('agent_a', 'tynn', 'atlas'))).toBeNull();
        expect(await hibernateWorkspace(f.ports, 'nope', { handoffWaitMs: 1, pollMs: 1 })).toEqual({ ok: false, reason: 'no workspace nope' });
    });
});

describe('remove from Genie', () => {
    it('stops its agents, forgets the workspace and its agents, and says plainly that the folder was not touched', async () => {
        const f = fakes({ running: ['agent_a'] });
        expect(await removeWorkspace(f.ports, 'tynn')).toEqual({ ok: true, agentsForgotten: 2, path: '/w/tynn', folderUntouched: true });
        expect(f.calls).toEqual(['stop:agent_a', 'forgetWorkspace:tynn']);
        expect(f.agents().map((a) => a.id)).toEqual(['agent_c']);
        expect(await removeWorkspace(f.ports, 'tynn')).toEqual({ ok: false, reason: 'no workspace tynn' });
    });
});
