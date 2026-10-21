import { describe, expect, it } from 'vitest';
import { parseEnvelopePlan, type EnvelopePlan } from '../src/core/envelope-plan.js';
import { parseTynnOwner, parseTynnProjectInput, tynnProjectSlug } from '../src/core/tynn.js';
import { buildEnvelope, type EnvelopePorts } from '../src/main/envelope-wizard-host.js';
import { TynnAccount, type TynnAccountPorts } from '../src/main/tynn-account.js';
import { createTynnProject, createWorkspace, listTynnOwners, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';

/**
 * THE OPTIONAL TYNN PROJECT LINK, ON EVERY "NEW ENVELOPE" ROUTE (Add workspace parity item 5; Genie 1's ProjectPicker in
 * AddWorkspaceModal.tsx :905-978 and InteractiveUpgradeWizard.tsx :1649-1676), AND A TYNN PROJECT CREATED INLINE (Genie 1's
 * CreateProjectForm :991-1114, ipc.ts :2578-2593 — without `is_gapp`: Genie 2 has no GApps).
 *
 * - New workspace: `createWorkspace(name, parent, remote?, tynnProjectId?)` — #1063 built it; #1064's rebase silently reverted it, so
 *   these are its tests again, as a regression guard.
 * - Open existing folder / Import from Git (the wizard's Workspace step): the plan carries `tynnProjectId`; the build looks
 *   it up in TYNN's own list on the host — never trusting the window — and writes project.json `tynn` {host, project,
 *   projectId}, as Import from Tynn writes it. A project Tynn does not list is refused BEFORE anything is written.
 * - Create a Tynn project: Tynn's `GET /api/v1/projects/owner-options` ({data: [{kind, id, label}]}) and
 *   `POST /api/v1/projects` ({name, slug?, owner_type?, owner_id?} → 201 {data: projectRow}), read from
 *   repos/tynn MeApiController::ownerOptions / createProject. Faked here; production Tynn is never called.
 */

const HOST = 'https://tynn.example';
const ACME = { id: 42, name: 'Acme', slug: 'acme', vision: null };

function fakes(over: { tynn?: WorkspaceOpsPorts['tynn'] | null } = {}) {
    const entries: Record<string, string[]> = { '/w': [] };
    const files: Record<string, unknown> = {};
    const calls: string[] = [];
    const key = (p: string) => p.replace(/\\/g, '/');
    const registered: string[] = [];
    const ports: WorkspaceOpsPorts = {
        fs: {
            exists: async (p) => key(p) in entries,
            entries: async (p) => entries[key(p)] ?? [],
            readJson: async (p) => files[key(p)] ?? null,
            writeJson: async (p, v) => { calls.push(`writeJson:${key(p)}`); files[key(p)] = v; },
            mkdir: async (p) => { calls.push(`mkdir:${key(p)}`); if (!(key(p) in entries)) entries[key(p)] = []; },
            writeText: async (p, text) => { calls.push(`writeText:${key(p)}`); files[key(p)] = text; },
            gitInit: async (p) => { calls.push(`gitInit:${key(p)}`); },
            gitFirstCommit: async (p) => { calls.push(`gitFirstCommit:${key(p)}`); },
            gitClone: async (url, into) => { calls.push(`gitClone:${url}:${key(into)}`); },
            gitCommit: async (p) => { calls.push(`gitCommit:${key(p)}`); },
            gitAddSubmodule: async (p, url, at) => { calls.push(`gitAddSubmodule:${key(p)}:${url}:${at}`); return null; },
        },
        registry: {
            workspace: () => null,
            list: () => [],
            addWorkspace: async (w) => { registered.push(w.id); },
            agentsOf: () => [],
            setAsleep: async () => true,
            forgetWorkspace: async () => null,
        },
        host: { probe: () => null, prompt: () => true, stop: () => true },
        attention: { finished: () => [] },
        terminals: { list: () => [], close: () => true },
        supervisor: { list: () => [], stop: () => true },
        now: () => 0,
        sleep: async () => {},
        tynn: over.tynn === null ? undefined : (over.tynn ?? { host: `${HOST}/`, projects: async () => [ACME] }),
    };
    const written = () => calls.filter((c) => c.startsWith('mkdir') || c.startsWith('writeJson') || c.startsWith('writeText') || c.startsWith('git'));
    return { ports, files, calls, registered, written };
}

const envPorts: EnvelopePorts = {
    analyse: async () => { throw new Error('not read in these tests'); },
    copy: async () => {},
    copyEnvFiles: async () => {},
    staging: { make: async () => '/stage', owns: () => false, remove: async () => {} },
};

const plan = (over: Partial<EnvelopePlan> = {}): EnvelopePlan => ({ name: 'Acme App', parent: '/w', source: '/src/acme-app', staged: false, repos: [], knowledge: [], primary: null, ...over });

describe('New workspace keeps its Tynn link (#1063, reverted by #1064 — restored)', () => {
    it('linked: project.json carries `tynn` from TYNN’s own list, not the window’s', async () => {
        const f = fakes();
        expect(await createWorkspace(f.ports, 'Acme Storefront', '/w', undefined, '42')).toMatchObject({ ok: true, id: 'acme-storefront' });
        expect(f.files['/w/acme-storefront.agi/project.json']).toMatchObject({ name: 'Acme Storefront', tynn: { host: HOST, project: 'acme', projectId: '42' } });
    });

    it('a project Tynn does not list for you, or no Tynn client: refused BEFORE anything is written', async () => {
        const f = fakes();
        expect(await createWorkspace(f.ports, 'acme', '/w', undefined, '99')).toMatchObject({ ok: false, reason: expect.stringMatching(/Tynn lists no project 99/) });
        const g = fakes({ tynn: null });
        expect(await createWorkspace(g.ports, 'acme', '/w', undefined, '42')).toMatchObject({ ok: false, reason: expect.stringMatching(/no Tynn client/) });
        expect([...f.written(), ...g.written()]).toEqual([]);
        expect([...f.registered, ...g.registered]).toEqual([]);
    });

    it('CONTROL: no project chosen — made and registered, with no `tynn` key', async () => {
        const f = fakes();
        expect(await createWorkspace(f.ports, 'acme', '/w')).toMatchObject({ ok: true, id: 'acme' });
        expect(f.files['/w/acme.agi/project.json']).toMatchObject({ name: 'acme' });
        expect(f.files['/w/acme.agi/project.json']).not.toHaveProperty('tynn');
    });
});

describe('Open existing folder / Import from Git: the wizard’s plan may link a Tynn project', () => {
    it('the build writes the link Tynn’s list gives for the chosen id, in the first commit’s project.json', async () => {
        const f = fakes();
        expect(await buildEnvelope(f.ports, envPorts, plan({ tynnProjectId: '42' }))).toMatchObject({ ok: true, id: 'acme-app' });
        expect(f.files['/w/acme-app.agi/project.json']).toMatchObject({ name: 'Acme App', tynn: { host: HOST, project: 'acme', projectId: '42' } });
        // Written BEFORE the first commit, so the link is committed with the envelope.
        const linkWrite = f.calls.indexOf('writeJson:/w/acme-app.agi/project.json');
        expect(linkWrite).toBeGreaterThanOrEqual(0);
        expect(linkWrite).toBeLessThan(f.calls.indexOf('gitFirstCommit:/w/acme-app.agi'));
        expect(f.registered).toEqual(['acme-app']);
    });

    it('an id Tynn does not list, or no Tynn client: refused before the envelope is made', async () => {
        const f = fakes();
        expect(await buildEnvelope(f.ports, envPorts, plan({ tynnProjectId: '99' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/Tynn lists no project 99/) });
        const g = fakes({ tynn: null });
        expect(await buildEnvelope(g.ports, envPorts, plan({ tynnProjectId: '42' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no Tynn client/) });
        expect([...f.written(), ...g.written()]).toEqual([]);
        expect([...f.registered, ...g.registered]).toEqual([]);
    });

    it('CONTROL: no project chosen — built, no `tynn` key, and Tynn is not asked', async () => {
        let asked = 0;
        const f = fakes({ tynn: { host: HOST, projects: async () => { asked += 1; return [ACME]; } } });
        expect(await buildEnvelope(f.ports, envPorts, plan())).toMatchObject({ ok: true });
        expect(f.files['/w/acme-app.agi/project.json']).not.toHaveProperty('tynn');
        expect(asked).toBe(0);
    });

    it('the plan carries the id over IPC and the remote wire; anything but a non-empty string is not a plan', () => {
        const wire = (p: unknown) => parseEnvelopePlan(JSON.parse(JSON.stringify(p)));
        expect(wire(plan({ tynnProjectId: '42' }))).toMatchObject({ tynnProjectId: '42' });
        expect(wire(plan())).not.toHaveProperty('tynnProjectId');
        expect(wire({ ...plan(), tynnProjectId: 42 })).toBeNull();
        expect(wire({ ...plan(), tynnProjectId: '' })).not.toHaveProperty('tynnProjectId');
    });
});

describe('creating a Tynn project inline (Genie 1’s CreateProjectForm, no GApp)', () => {
    it('the slug Genie 1 derived from the name: lower-case, runs of anything else one dash, no dash at the ends', () => {
        expect(tynnProjectSlug('My New Project')).toBe('my-new-project');
        expect(tynnProjectSlug('  Acme -- Storefront!  ')).toBe('acme-storefront');
        expect(tynnProjectSlug('***')).toBe('');
    });

    it('owners are Tynn’s rows as Tynn names them; anything else is left out', () => {
        expect(parseTynnOwner({ kind: 'user', id: '7', label: 'Personal (your account)' })).toEqual({ kind: 'user', id: '7', label: 'Personal (your account)' });
        expect(parseTynnOwner({ kind: 'organization', id: 3, label: 'Acme Org' })).toEqual({ kind: 'organization', id: '3', label: 'Acme Org' });
        expect(parseTynnOwner({ kind: 'galaxy', id: '1', label: 'x' })).toBeNull();
        expect(parseTynnOwner({ kind: 'team', id: '1' })).toBeNull();
        expect(parseTynnOwner(null)).toBeNull();
    });

    it('listTynnOwners: Tynn’s list, parsed; no client or a refusal is said in words', async () => {
        const f = fakes({ tynn: { host: HOST, projects: async () => [], ownerOptions: async () => [{ kind: 'user', id: '7', label: 'Personal (your account)' }, { kind: 'bogus' }, { kind: 'team', id: '9', label: 'Core — Acme' }] } });
        expect(await listTynnOwners(f.ports)).toEqual({ ok: true, owners: [{ kind: 'user', id: '7', label: 'Personal (your account)' }, { kind: 'team', id: '9', label: 'Core — Acme' }] });
        expect(await listTynnOwners(fakes({ tynn: null }).ports)).toMatchObject({ ok: false, reason: expect.stringMatching(/no Tynn client/) });
        const down = fakes({ tynn: { host: HOST, projects: async () => [], ownerOptions: async () => { throw new Error('Tynn answered 500'); } } });
        expect(await listTynnOwners(down.ports)).toEqual({ ok: false, reason: 'Tynn answered 500' });
    });

    it('createTynnProject: Tynn’s body — no is_gapp — and the new project back in the list’s own shape', async () => {
        const sent: unknown[] = [];
        const f = fakes({ tynn: { host: HOST, projects: async () => [], createProject: async (body) => { sent.push(body); return { id: 77, name: 'Acme App', slug: 'acme-app', vision: null }; } } });
        const r = await createTynnProject(f.ports, { name: '  Acme App ', slug: 'acme-app', owner: { kind: 'organization', id: '3' } });
        expect(r).toEqual({ ok: true, project: expect.objectContaining({ id: '77', name: 'Acme App', slug: 'acme-app' }) });
        expect(sent).toEqual([{ name: 'Acme App', slug: 'acme-app', owner_type: 'organization', owner_id: '3' }]);
        // Personal, no slug: Tynn derives the slug and takes the session's own user.
        await createTynnProject(f.ports, { name: 'Solo', slug: '  ', owner: null });
        expect(sent[1]).toEqual({ name: 'Solo' });
        expect(JSON.stringify(sent)).not.toContain('is_gapp');
    });

    it('the create request from a window is narrowed: strings only, an owner of a kind Tynn knows, nothing else carried', () => {
        expect(parseTynnProjectInput({ name: 'Acme', slug: 'acme', owner: { kind: 'team', id: '9' } })).toEqual({ name: 'Acme', slug: 'acme', owner: { kind: 'team', id: '9' } });
        expect(parseTynnProjectInput({ name: 'Acme', slug: '', owner: null, is_gapp: true })).toEqual({ name: 'Acme', slug: '', owner: null });
        expect(parseTynnProjectInput({ name: 'Acme', slug: '', owner: { kind: 'galaxy', id: '1' } })).toBeNull();
        expect(parseTynnProjectInput({ name: 42, slug: '', owner: null })).toBeNull();
        expect(parseTynnProjectInput(null)).toBeNull();
    });

    it('createTynnProject refuses a blank name before asking Tynn; Tynn’s refusal and a row that is not a project are said', async () => {
        let asked = 0;
        const refusing = fakes({ tynn: { host: HOST, projects: async () => [], createProject: async () => { asked += 1; throw new Error('The slug has already been taken.'); } } });
        expect(await createTynnProject(refusing.ports, { name: '   ', slug: '', owner: null })).toEqual({ ok: false, reason: 'Give the project a name.' });
        expect(asked).toBe(0);
        expect(await createTynnProject(refusing.ports, { name: 'Acme', slug: '', owner: null })).toEqual({ ok: false, reason: 'The slug has already been taken.' });
        const odd = fakes({ tynn: { host: HOST, projects: async () => [], createProject: async () => ({ nope: true }) } });
        expect(await createTynnProject(odd.ports, { name: 'Acme', slug: '', owner: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/not a project/) });
        expect(await createTynnProject(fakes({ tynn: null }).ports, { name: 'Acme', slug: '', owner: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/no Tynn client/) });
    });
});

describe('TynnAccount: owner-options and create-project over the signed-in session (Genie 1’s TynnBackend)', () => {
    function tynn(answer: { status: number; body: unknown }) {
        const calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
        const ports: TynnAccountPorts = {
            host: () => HOST,
            cookies: { set: async () => {}, get: async (_h, name) => (name === 'XSRF-TOKEN' ? 'xsrf%3Dvalue' : null), clear: async () => {} },
            fetch: async (url, init) => {
                const path = url.slice(HOST.length);
                calls.push({ method: init.method, path, headers: init.headers, ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}) });
                const res = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
                if (path === '/api/v1/me') return res(200, { id: '7', name: 'Ada', email: 'ada@example.com' });
                if (path === '/api/v1/projects/owner-options' && init.method === 'GET') return res(200, { data: [{ kind: 'user', id: '7', label: 'Personal (your account)' }] });
                if (path === '/api/v1/projects' && init.method === 'POST') return res(answer.status, answer.body);
                return res(404, { message: 'Not Found' });
            },
        };
        return { ports, calls };
    }

    it('ownerOptions: GET /api/v1/projects/owner-options, Tynn’s `data`', async () => {
        const t = tynn({ status: 201, body: {} });
        const account = await TynnAccount.open(t.ports);
        expect(await account.ownerOptions()).toEqual([{ kind: 'user', id: '7', label: 'Personal (your account)' }]);
        expect(t.calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/v1/projects/owner-options' });
    });

    it('createProject: POST /api/v1/projects with the body as given and the XSRF header; 201’s `data` back', async () => {
        const t = tynn({ status: 201, body: { data: { id: '77', name: 'Acme', slug: 'acme' } } });
        const account = await TynnAccount.open(t.ports);
        expect(await account.createProject({ name: 'Acme', owner_type: 'team', owner_id: '9' })).toEqual({ id: '77', name: 'Acme', slug: 'acme' });
        expect(t.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/v1/projects', body: { name: 'Acme', owner_type: 'team', owner_id: '9' }, headers: { 'X-XSRF-TOKEN': 'xsrf=value' } });
    });

    it('createProject: Tynn’s 422 message and 403 are said in words, never a bare status', async () => {
        const invalid = await TynnAccount.open(tynn({ status: 422, body: { message: 'The name field is required.', errors: { name: ['The name field is required.'] } } }).ports);
        await expect(invalid.createProject({ name: '' })).rejects.toThrow('The name field is required.');
        const forbidden = await TynnAccount.open(tynn({ status: 403, body: { error: 'forbidden' } }).ports);
        await expect(forbidden.createProject({ name: 'Acme', owner_type: 'organization', owner_id: '3' })).rejects.toThrow(/Tynn does not let you create a project under that owner/);
    });

    it('signed out: refused before any request', async () => {
        const calls: string[] = [];
        const account = await TynnAccount.open({
            host: () => HOST,
            cookies: { set: async () => {}, get: async () => null, clear: async () => {} },
            fetch: async (url) => { calls.push(url); return { ok: false, status: 401, text: async () => '{}' }; },
        });
        const before = calls.length;
        await expect(account.ownerOptions()).rejects.toThrow(/Sign in to Tynn first/);
        await expect(account.createProject({ name: 'Acme' })).rejects.toThrow(/Sign in to Tynn first/);
        expect(calls.length).toBe(before);
    });
});
