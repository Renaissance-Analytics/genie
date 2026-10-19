import { describe, expect, it } from 'vitest';
import { addWorkspaceFromTynn, listTynnProjects, previewAddFromTynn, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';

/**
 * ADD A WORKSPACE FROM TYNN (§6.1) — the host half. Signed in (main/tynn-account.ts), Genie lists the person's own
 * projects (Genie 1's GET /api/v1/projects, over the session) and the person picks one, as in Genie 1; the preview shows the plan for THAT
 * project and nothing is written until the person confirms. Confirm creates the
 * folder, writes the manifest the plan showed (name, vision, the `tynn` link), lays out the envelope and
 * registers it — through the same `addWorkspace` every other source uses. Tynn's refusal, a token that is
 * not a project token, a missing token and an existing folder are each a refusal in words with nothing
 * written. The Tynn call is a port: no network here.
 */

const SCHEMA = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.2.0/schemas/workspace/project.schema.json';

function fakes(over: { entries?: Record<string, string[]>; tynn?: () => Promise<unknown[]> } = {}) {
    const entries: Record<string, string[]> = { ...(over.entries ?? {}) };
    const files: Record<string, unknown> = {};
    const calls: string[] = [];
    const key = (p: string) => p.replace(/\\/g, '/');
    const ports: WorkspaceOpsPorts = {
        fs: {
            exists: async (p) => key(p) in entries,
            entries: async (p) => entries[key(p)] ?? [],
            readJson: async (p) => files[key(p)] ?? null,
            writeJson: async (p, v) => { calls.push(`writeJson:${key(p)}`); files[key(p)] = v; },
            mkdir: async (p) => { calls.push(`mkdir:${key(p)}`); entries[key(p)] = entries[key(p)] ?? []; },
            gitInit: async (p) => { calls.push(`gitInit:${key(p)}`); },
            gitClone: async (url, into) => { calls.push(`gitClone:${url}:${key(into)}`); },
        },
        registry: {
            workspace: () => null,
            addWorkspace: async (r) => { calls.push(`register:${r.id}:${key(r.path)}`); },
            agentsOf: () => [],
            setAsleep: async () => true,
            forgetWorkspace: async () => null,
        },
        host: { probe: () => null, prompt: () => true, stop: () => true },
        attention: { finished: () => [] },
        terminals: { list: () => [], close: () => true },
        supervisor: { list: () => [], stop: () => true },
        now: () => 1,
        sleep: async () => {},
        tynn: {
            host: 'https://tynn.ai',
            projects: over.tynn ?? (async () => [
                { id: '01JAAAAAAAAAAAAAAAAAAAAAAA', name: 'Acme', slug: 'acme', owner_name: 'Ada' },
                { id: 42, name: 'Tynn.ai', slug: 'tynn', vision: 'Agentic project management.' },
            ]),
        },
    };
    return { ports, calls, files };
}

describe('listTynnProjects', () => {
    it('the person’s projects as Tynn lists them; a row that is not a project is left out', async () => {
        const f = fakes({ tynn: async () => [{ id: 42, name: 'Tynn.ai', slug: 'tynn' }, { id: 3, email: 'a@b.invalid' }, { id: 'p2', name: 'Acme', slug: 'acme' }] });
        expect(await listTynnProjects(f.ports)).toEqual({ ok: true, host: 'https://tynn.ai', projects: [{ id: '42', name: 'Tynn.ai', slug: 'tynn', vision: null }, { id: 'p2', name: 'Acme', slug: 'acme', vision: null }] });
    });

    it('signed out, or Tynn refusing, is a refusal in Tynn’s words', async () => {
        const f = fakes({ tynn: async () => { throw new Error('Sign in to Tynn first (Settings → Workstation → Integrations → Open Tynn in your browser)'); } });
        expect(await listTynnProjects(f.ports)).toEqual({ ok: false, reason: 'Sign in to Tynn first (Settings → Workstation → Integrations → Open Tynn in your browser)' });
    });
});

describe('previewAddFromTynn', () => {
    it('the CHOSEN project’s plan — not the first one listed — and nothing written', async () => {
        const f = fakes();
        const plan = await previewAddFromTynn(f.ports, '/w', '42');
        expect(plan).toMatchObject({ ok: true, source: 'tynn', path: '/w/tynn', parent: '/w', kind: 'empty', project: { id: '42', name: 'Tynn.ai', slug: 'tynn' } });
        expect(f.calls).toEqual([]);
    });

    it('Tynn’s refusal, a project Tynn does not list for this person, and an existing folder are refusals in words', async () => {
        const refused = fakes({ tynn: async () => { throw new Error('Tynn answered 403: Invalid token'); } });
        expect(await previewAddFromTynn(refused.ports, '/w', '42')).toEqual({ ok: false, reason: 'Tynn answered 403: Invalid token' });
        const unknown = fakes();
        expect(await previewAddFromTynn(unknown.ports, '/w', '99')).toEqual({ ok: false, reason: 'Tynn lists no project 99 for you — it may have been deleted, or shared with someone else' });
        const exists = fakes({ entries: { '/w/tynn': ['x'] } });
        expect(await previewAddFromTynn(exists.ports, '/w', '42')).toMatchObject({ ok: false, reason: expect.stringContaining('already exists') });
        expect(refused.calls.concat(unknown.calls, exists.calls)).toEqual([]);
    });
});

describe('addWorkspaceFromTynn', () => {
    it('creates the folder, writes the manifest the plan showed, lays out the envelope and registers it', async () => {
        const f = fakes();
        const result = await addWorkspaceFromTynn(f.ports, '/w', '42');
        expect(result).toEqual({ ok: true, id: 'tynn', kind: 'empty', stamped: null });
        expect(f.calls[0]).toBe('mkdir:/w/tynn');
        expect(f.calls).toContain('mkdir:/w/tynn/repos');
        expect(f.calls).toContain('mkdir:/w/tynn/.ai');
        expect(f.calls).toContain('writeJson:/w/tynn/project.json');
        expect(f.calls).toContain('gitInit:/w/tynn');
        expect(f.calls[f.calls.length - 1]).toBe('register:tynn:/w/tynn');
        expect(f.files['/w/tynn/project.json']).toMatchObject({
            $schema: SCHEMA,
            name: 'Tynn.ai',
            type: 'agi',
            description: 'Agentic project management.',
            repos: [],
            tynn: { host: 'https://tynn.ai', project: 'tynn', projectId: '42' },
        });
    });

    it('a refused preview writes nothing', async () => {
        const f = fakes({ tynn: async () => { throw new Error('Tynn answered 403: Permission denied'); } });
        expect(await addWorkspaceFromTynn(f.ports, '/w', '42')).toEqual({ ok: false, reason: 'Tynn answered 403: Permission denied' });
        expect(f.calls).toEqual([]);
    });
});
