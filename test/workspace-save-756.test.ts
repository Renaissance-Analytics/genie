import { describe, expect, it } from 'vitest';
import { savePathProblem, scanForMachineState } from '../src/core/workspace-save-guard.js';
import { applyMerge, diffFiles, elementsOf, mergeElements, planSave, requiredRevision, type LiveModel, type MergeDecision } from '../src/core/workspace-save.js';
import { WorkspaceSave, type SaveFs, type SaveGit } from '../src/main/workspace-save-host.js';

/**
 * SAVE TO REPO (Tynn #756, PR2): the planner, the guard that keeps a machine out of a repo, the diff, and the
 * upstream-aware merge a team sharing one workspace across workstations needs.
 *
 * The first RED fixture is this envelope's OWN `tynn-c5` site (project.json, key 998de12a1f1278a9): its command holds
 * `C:/_Projects/tynn.ai/.ai/sandbox/...`, and its repo `tynn-c5-proof` is not in `repos[]`. Saved as is, that entry would put
 * a drive letter in every teammate's clone.
 */

const TYNN_C5 = {
    repo: 'tynn-c5-proof',
    runMode: 'host',
    kind: 'http',
    enabled: true,
    name: 'tynn-c5',
    genName: 'tynn-c5.gen',
    command: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/_Projects/tynn.ai/.ai/sandbox/genie-marketplace-c5/serve-proof.ps1', '-Port', '{port}'],
};
const TYNN_SITE = { repo: 'tynn', runMode: 'host', kind: 'http', enabled: true, name: 'tynn', genName: 'tynn.gen', stack: 'php', framework: 'laravel', browserExposed: true, hostServe: { mode: 'php', root: 'public' } };
const V4 = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.4.0/schemas/workspace/project.schema.json';
const V5 = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.5.0/schemas/workspace/project.schema.json';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const modelOf = (manifest: Record<string, unknown>, files: LiveModel['files'] = [], text?: string): LiveModel => ({ manifest, manifestText: text ?? json(manifest), files });
const cleanManifest = (extra: Record<string, unknown> = {}) => ({ $schema: V4, name: 'Tynn', repos: [{ name: 'tynn', path: 'repos/tynn' }], sites: { adfaa1cb572c9c36: TYNN_SITE }, ...extra });

describe('the guard: no machine in a repo', () => {
    it('names the field that holds a Windows path: the tynn-c5 command', () => {
        const found = scanForMachineState({ sites: { '998de12a1f1278a9': TYNN_C5 } });
        const hit = found.find((v) => v.path === 'sites.998de12a1f1278a9.command[5]');
        expect(hit?.rule).toBe('absolute-path');
        expect(hit?.reason).toContain('sites.998de12a1f1278a9.command[5]');
    });

    it('catches a POSIX path, a UNC path and a path inside a longer command string', () => {
        const found = scanForMachineState({ a: '/home/ana/work/app', b: '\\\\server\\share\\x', c: 'node --require /opt/tool/hook.js app.js' });
        expect(found.map((v) => [v.path, v.rule])).toEqual([['a', 'absolute-path'], ['b', 'absolute-path'], ['c', 'absolute-path']]);
    });

    it('catches a loopback address with a port, in a string at any depth', () => {
        const found = scanForMachineState({ service: { urls: ['http://127.0.0.1:54321/health', 'localhost:3306'] } });
        expect(found.map((v) => [v.path, v.rule])).toEqual([['service.urls[0]', 'port'], ['service.urls[1]', 'port']]);
    });

    it('catches secret-named keys at any depth', () => {
        const found = scanForMachineState({ a: { password: 'p' }, b: [{ token: 't' }], c: { nested: { apiKey: 'k', Authorization: 'x', privateKey: 'y' } }, secret: 1 });
        expect(found.map((v) => v.path).sort()).toEqual(['a.password', 'b[0].token', 'c.nested.Authorization', 'c.nested.apiKey', 'c.nested.privateKey', 'secret']);
        expect(found.every((v) => v.rule === 'secret-key')).toBe(true);
    });

    it('catches a secret VALUE even under an innocent key', () => {
        const found = scanForMachineState({ note: 'use sk-abcdefghijklmnopqrstuvwx', other: 'ghp_abcdefghijklmnopqrstuvwxyz0123', pem: '-----BEGIN RSA PRIVATE KEY-----' });
        expect(found.map((v) => [v.path, v.rule])).toEqual([['note', 'secret-value'], ['other', 'secret-value'], ['pem', 'secret-value']]);
    });

    it('catches machine state and capability grants: pid, workspaceId, armed, wanted, ports, autoApprove, permissions', () => {
        const planted = { pid: 4242, workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', armed: true, wanted: true, publishedPort: 55432, containerName: 'c', autoApprove: true, permissions: { write: true }, approval_gates: 'none', lastRunAt: 1 };
        const found = scanForMachineState({ item: planted });
        expect(found.map((v) => v.path).sort()).toEqual(Object.keys(planted).map((k) => `item.${k}`).sort());
        expect(found.every((v) => v.rule === 'machine-key')).toBe(true);
    });

    it('a `cwd` is a folder like any other: relative is fine (a flow step runs in one), and one outside the workspace is its own violation', () => {
        expect(scanForMachineState({ config: { cwd: 'repos/app' } })).toEqual([]);
        expect(scanForMachineState({ config: { cwd: 'C:/Users/x/app' } }).map((v) => [v.path, v.rule])).toEqual([['config.cwd', 'unsafe-cwd']]);
    });

    it('CONTROL: a clean entry (relative folder, the {port} token, https URL, hostPort, envKeys names) has no violations', () => {
        const clean = {
            command: ['npm', 'run', 'dev', '--', '--port={port}'],
            folder: 'repos/app',
            url: 'https://tynn.ai/api/v1',
            flag: '/c',
            hostPort: 3000,
            internalPort: 5432,
            envKeys: ['MEILI_MASTER_KEY', 'DB_PASSWORD'],
            hostServe: { mode: 'php', root: 'public' },
        };
        expect(scanForMachineState({ sites: { k: clean } })).toEqual([]);
    });

    it('each planted value is detected on its own, so "none found" cannot be a broken scanner', () => {
        const plants: Record<string, unknown> = { path: 'C:/x/y', posix: '/var/lib/x', port: '127.0.0.1:8080', pass: { password: 'p' }, pid: { pid: 1 }, armed: { armed: true }, grant: { autoApprove: true } };
        for (const [name, value] of Object.entries(plants)) {
            expect(scanForMachineState({ planted: value }, 'root').length, `${name} was not detected`).toBeGreaterThan(0);
        }
    });

    it('CONTROL: hostPort (a port the person declared for a server already running) is not a violation', () => {
        expect(scanForMachineState({ sites: { a: { hostPort: 3000 } } })).toEqual([]);
    });

    it('CONTROL: a save may write project.json, .flows/<n>.json, .processes/<n>.json and .genie/tabs.json', () => {
        for (const ok of ['project.json', '.flows/nightly.json', '.processes/queue-worker.json', '.genie/tabs.json']) expect(savePathProblem(ok), ok).toBeNull();
    });

    it('refuses to write anywhere else', () => {
        for (const bad of ['../x.json', 'C:/x.json', '/etc/x.json', '.flows/a/b.json', '.flows/.json', '.ai/x.json', 'repos/tynn/project.json', 'project.json.bak', '.genie/other.json']) {
            expect(savePathProblem(bad), bad).not.toBeNull();
        }
    });
});

describe('the planner', () => {
    it("refuses this envelope's own tynn-c5 site, names the field, and plans nothing", () => {
        const plan = planSave(modelOf(cleanManifest({ sites: { adfaa1cb572c9c36: TYNN_SITE, '998de12a1f1278a9': TYNN_C5 } })));
        expect(plan.ok).toBe(false);
        if (plan.ok) return;
        const hit = plan.violations.find((v) => v.path === 'project.json.sites.998de12a1f1278a9.command[5]');
        expect(hit?.rule).toBe('absolute-path');
        expect(plan.reason).toContain('sites.998de12a1f1278a9.command[5]');
    });

    it("plans project.json in the file's own style: tab indent, CRLF, no trailing newline", () => {
        const manifest = cleanManifest();
        const text = JSON.stringify(manifest, null, '\t').replace(/\n/g, '\r\n');
        const plan = planSave(modelOf(manifest, [], text));
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.files).toEqual([{ path: 'project.json', text }]);
    });

    it('refuses a manifest that declares a NEWER schema, and plans nothing', () => {
        const plan = planSave(modelOf(cleanManifest({ $schema: 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v9.0.0/schemas/workspace/project.schema.json' })));
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.reason).toMatch(/9\.0\.0/);
    });

    it('refuses an element file outside the places a save writes', () => {
        const plan = planSave(modelOf(cleanManifest(), [{ path: '../x.json', value: {} }]));
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.reason).toContain('../x.json');
    });

    it('one violation in an element file refuses the WHOLE save, project.json included', () => {
        const bad = planSave(modelOf(cleanManifest(), [{ path: '.processes/q.json', value: { command: 'php artisan queue:work', folder: 'C:/a/app' } }]));
        expect(bad.ok).toBe(false);
        if (bad.ok) return;
        expect(bad.violations.map((v) => v.path)).toContain('.processes/q.json.folder');
    });

    it('CONTROL for the above: the same element with a relative folder is planned, 2-space JSON with a trailing newline', () => {
        const value = { command: 'php artisan queue:work', folder: 'repos/app' };
        const plan = planSave(modelOf(cleanManifest(), [{ path: '.processes/q.json', value }]));
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.files.map((f) => f.path)).toEqual(['project.json', '.processes/q.json']);
        expect(plan.files[1]!.text).toBe(json(value));
    });

    it('says which schema revision the manifest needs: services, workspace and issueWatch are 0.5.0', () => {
        expect(requiredRevision({ name: 'x' })).toBe('0.4.0');
        expect(requiredRevision({ agents: { lift: { purpose: 'p' } } })).toBe('0.4.0');
        expect(requiredRevision({ services: [] })).toBe('0.5.0');
        expect(requiredRevision({ workspace: {} })).toBe('0.5.0');
        expect(requiredRevision({ agents: { lift: { purpose: 'p', issueWatch: { delivery: 'off', kinds: [] } } } })).toBe('0.5.0');
    });

    it('a writer at 0.4.0 refuses a manifest that needs 0.5.0; a writer at 0.5.0 stamps the pinned tag', () => {
        const manifest = cleanManifest({ services: [{ engine: 'redis' }] });
        const old = planSave(modelOf(manifest), { revision: '0.4.0' });
        expect(old.ok).toBe(false);
        if (!old.ok) expect(old.reason).toContain('0.5.0');
        const now = planSave(modelOf(manifest), { revision: '0.5.0' });
        expect(now.ok).toBe(true);
        if (!now.ok) return;
        expect(now.stampedTo).toBe('0.5.0');
        expect(JSON.parse(now.files[0]!.text).$schema).toBe(V5);
    });

    it('keeps a backup only when the manifest was unstamped', () => {
        const services = { services: [{ engine: 'redis' }] };
        const unstamped = { name: 'Tynn', ...services };
        const first = planSave(modelOf(unstamped), { revision: '0.5.0' });
        expect(first.ok && first.backups).toEqual([{ path: 'project.json.pre-schema-0.5.0.bak', text: json(unstamped) }]);
        const stamped = planSave(modelOf({ $schema: V4, name: 'Tynn', ...services }), { revision: '0.5.0' });
        expect(stamped.ok && stamped.backups).toEqual([]);
    });

    it('CONTROL: planning does not change the model it was given', () => {
        const model = modelOf(cleanManifest({ services: [{ engine: 'redis' }] }), [{ path: '.genie/tabs.json', value: { tabs: [] } }]);
        const before = JSON.stringify(model);
        planSave(model, { revision: '0.5.0' });
        expect(JSON.stringify(model)).toBe(before);
    });
});

describe('the diff against what is on disk', () => {
    it('says added, changed or unchanged for each planned file', () => {
        const files = [{ path: 'project.json', text: 'a' }, { path: '.flows/x.json', text: 'b' }, { path: '.processes/y.json', text: 'c' }];
        const onDisk = new Map<string, string | null>([['project.json', 'a'], ['.flows/x.json', 'old'], ['.processes/y.json', null]]);
        expect(diffFiles(files, onDisk)).toEqual([
            { path: 'project.json', status: 'unchanged' },
            { path: '.flows/x.json', status: 'changed' },
            { path: '.processes/y.json', status: 'added' },
        ]);
    });
});

describe('elements: the unit a merge is made in', () => {
    const manifest = json({ $schema: V5, name: 'Tynn', sites: { a1: { name: 'a' }, b2: { name: 'b' } }, agents: { lift: { purpose: 'p' } }, services: [{ engine: 'postgres', variant: 'pgvector', version: '17' }, { engine: 'redis' }, { engine: 'custom', name: 'search', image: 'i', internalPort: 1, kind: 'http' }], workspace: { agentCap: 4 } });

    it('splits project.json into one element per site, agent and service, and one per other key; $schema is not one', () => {
        const ids = [...elementsOf('project.json', manifest).keys()].sort();
        expect(ids).toEqual([
            'project.json#agents/lift',
            'project.json#name',
            'project.json#services/custom:search',
            'project.json#services/postgres:pgvector',
            'project.json#services/redis',
            'project.json#sites/a1',
            'project.json#sites/b2',
            'project.json#workspace',
        ]);
        expect(elementsOf('project.json', manifest).get('project.json#sites/a1')).toEqual({ name: 'a' });
    });

    it('is one element per file for a flow, a process and the tabs', () => {
        for (const path of ['.flows/a.json', '.processes/b.json', '.genie/tabs.json']) {
            expect([...elementsOf(path, json({ x: 1 })).keys()]).toEqual([path]);
        }
    });

    it('CONTROL: no file is no elements', () => {
        expect(elementsOf('project.json', null).size).toBe(0);
    });
});

describe('upstream merge: per element, never a blind overwrite', () => {
    const kinds = (decisions: readonly MergeDecision[]) => Object.fromEntries(decisions.map((d) => [d.id, d.kind]));
    const inputOf = (base: unknown, local: unknown, incoming: unknown) => ({
        base: new Map([['project.json', base === null ? null : json(base)]]),
        local: new Map([['project.json', local === null ? null : json(local)]]),
        incoming: new Map([['project.json', incoming === null ? null : json(incoming)]]),
    });
    const base = { name: 'T', sites: { a: { n: 1 }, b: { n: 1 }, c: { n: 1 }, d: { n: 1 } } };

    it('classifies each element: same, ours only, theirs only, both changed', () => {
        const local = { name: 'T', sites: { a: { n: 1 }, b: { n: 2 }, c: { n: 3 }, d: { n: 4 } } };
        const incoming = { name: 'T', sites: { a: { n: 1 }, b: { n: 1 }, c: { n: 9 }, d: { n: 4 } } };
        expect(kinds(mergeElements(inputOf(base, local, incoming)))).toEqual({
            'project.json#name': 'same',
            'project.json#sites/a': 'same',
            'project.json#sites/b': 'local',
            'project.json#sites/c': 'conflict',
            'project.json#sites/d': 'same',
        });
    });

    it('a teammate-added element comes in, and one we added stays', () => {
        const local = { ...base, sites: { ...base.sites, mine: { n: 1 } } };
        const incoming = { ...base, sites: { ...base.sites, theirs: { n: 1 } } };
        const k = kinds(mergeElements(inputOf(base, local, incoming)));
        expect(k['project.json#sites/theirs']).toBe('incoming');
        expect(k['project.json#sites/mine']).toBe('local');
    });

    it('an element removed upstream that we did not touch is taken as a removal; one we changed is a conflict', () => {
        const incoming = { name: 'T', sites: { a: { n: 1 }, c: { n: 1 }, d: { n: 1 } } };
        const local = { name: 'T', sites: { a: { n: 1 }, b: { n: 1 }, c: { n: 1 }, d: { n: 5 } } };
        const k = kinds(mergeElements(inputOf(base, local, incoming)));
        expect(k['project.json#sites/b']).toBe('incoming');
        const touched = kinds(mergeElements(inputOf(base, { ...local, sites: { ...local.sites, b: { n: 7 } } }, incoming)));
        expect(touched['project.json#sites/b']).toBe('conflict');
    });

    it('both sides changing an element to the SAME value is not a conflict', () => {
        const same = { name: 'T', sites: { ...base.sites, a: { n: 8 } } };
        expect(kinds(mergeElements(inputOf(base, same, same)))['project.json#sites/a']).toBe('same');
    });

    const conflictLocal = { name: 'T', sites: { a: { n: 1 }, mine: { n: 1 } } };
    const conflictIncoming = { name: 'T', sites: { a: { n: 2 }, theirs: { n: 1 } } };
    const decisions = () => mergeElements(inputOf({ name: 'T', sites: { a: { n: 0 } } }, { ...conflictLocal, sites: { ...conflictLocal.sites, a: { n: 1 } } }, conflictIncoming));
    const localText = (indent: string | number = 2) => `${JSON.stringify(conflictLocal, null, indent)}\n`;

    it('an unresolved conflict refuses to apply, and names it', () => {
        const result = applyMerge('project.json', localText(), decisions(), {});
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.unresolved).toEqual(['project.json#sites/a']);
    });

    it("applies the person's choice per element, keeps what is ours, brings in what is theirs, in the file's style", () => {
        const text = localText('\t');
        const theirs = applyMerge('project.json', text, decisions(), { 'project.json#sites/a': 'incoming' });
        expect(theirs.ok).toBe(true);
        if (!theirs.ok) return;
        const merged = JSON.parse(theirs.text);
        expect(merged.sites.a).toEqual({ n: 2 });
        expect(merged.sites.mine).toEqual({ n: 1 });
        expect(merged.sites.theirs).toEqual({ n: 1 });
        expect(theirs.text.startsWith('{\n\t"name"')).toBe(true);
        const ours = applyMerge('project.json', text, decisions(), { 'project.json#sites/a': 'local' });
        expect(ours.ok && JSON.parse(ours.text).sites.a).toEqual({ n: 1 });
    });

    it('an element only they changed is taken without being asked', () => {
        const result = applyMerge('project.json', localText(), decisions(), { 'project.json#sites/a': 'local' });
        expect(result.ok && JSON.parse(result.text).sites.theirs).toEqual({ n: 1 });
    });

    it('an element they removed (and we left alone) is removed', () => {
        const b = { name: 'T', sites: { a: { n: 1 }, gone: { n: 1 } } };
        const d = mergeElements(inputOf(b, b, { name: 'T', sites: { a: { n: 1 } } }));
        const result = applyMerge('project.json', json(b), d, {});
        expect(result.ok && JSON.parse(result.text).sites).toEqual({ a: { n: 1 } });
    });
});

describe('Save to repo, in main', () => {
    const WS = '/w/tynn';
    const file = (p: string) => `${WS}/${p}`;
    const BASE = { name: 'T', sites: { a: { name: 'a' } } };
    const LOCAL = { name: 'T', sites: { a: { name: 'a2' }, b: { name: 'b' } } };
    const THEIRS = { name: 'T', sites: { a: { name: 'a3' }, c: { name: 'c' } } };

    function rig(options: { fetch?: { ok: true } | { ok: false; reason: string }; upstream?: string | null; live?: LiveModel | null; onDisk?: Record<string, string>; failWriteOf?: string; mayRead?: boolean } = {}) {
        const calls: string[] = [];
        const disk: Record<string, string> = { [file('project.json')]: json(BASE), ...(options.onDisk ?? {}) };
        const writes: [string, string][] = [];
        const fs: SaveFs = {
            async readText(path) { calls.push(`read ${path}`); return disk[path] ?? null; },
            async writeTextAtomic(path, text) {
                if (options.failWriteOf !== undefined && path.endsWith(options.failWriteOf)) throw new Error('disk full');
                writes.push([path, text]);
                disk[path] = text;
            },
        };
        const upstream = options.upstream === undefined ? 'origin/main' : options.upstream;
        const git: SaveGit = {
            async fetchUpstream() { calls.push('fetch'); return options.fetch ?? { ok: true }; },
            async upstream() { calls.push('upstream'); return upstream; },
            async mergeBase() { calls.push('mergeBase'); return 'base1'; },
            async show(_cwd, ref, path) { calls.push(`show ${ref} ${path}`); return ref === 'base1' ? (path === 'project.json' ? json(BASE) : null) : ref === 'origin/main' && path === 'project.json' ? json(THEIRS) : null; },
        };
        const live = options.live === undefined ? modelOf(LOCAL) : options.live;
        const save = new WorkspaceSave({ fs, git, liveModel: async () => live, ...(options.mayRead === undefined ? {} : { mayReadFolder: () => options.mayRead! }) });
        return { save, calls, writes, disk };
    }

    it('fetches first, before it reads anything upstream', async () => {
        const { save, calls } = rig();
        await save.preview(WS);
        expect(calls[0]).toBe('fetch');
        expect(calls.indexOf('fetch')).toBeLessThan(calls.findIndex((c) => c.startsWith('show ')));
    });

    it('a failed fetch does not stop the preview and says why', async () => {
        const { save } = rig({ fetch: { ok: false, reason: 'could not resolve host' } });
        const preview = await save.preview(WS);
        expect(preview.upstream).toEqual({ fetched: false, ref: 'origin/main', reason: 'could not resolve host' });
        expect(preview.plan.ok).toBe(true);
    });

    it('shows each element as ours, theirs or in conflict', async () => {
        const preview = await rig().save.preview(WS);
        const kinds = Object.fromEntries(preview.decisions.map((d) => [d.id, d.kind]));
        expect(kinds['project.json#sites/a']).toBe('conflict');
        expect(kinds['project.json#sites/b']).toBe('local');
        expect(kinds['project.json#sites/c']).toBe('incoming');
        expect(preview.conflicts).toEqual(['project.json#sites/a']);
        expect(preview.files).toEqual([{ path: 'project.json', status: 'changed' }]);
    });

    it('no tracking branch: the preview is only the local diff', async () => {
        const { save } = rig({ upstream: null });
        const preview = await save.preview(WS);
        expect(preview.upstream.ref).toBeNull();
        expect(preview.decisions).toEqual([]);
        expect(preview.files).toEqual([{ path: 'project.json', status: 'changed' }]);
    });

    it('refuses a save with a violation and writes nothing; CONTROL: the clean model writes', async () => {
        const dirty = rig({ upstream: null, live: modelOf({ ...LOCAL, sites: { k: TYNN_C5 } }) });
        const refused = await dirty.save.save(WS);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.reason).toContain('sites.k.command[5]');
        expect(dirty.writes).toEqual([]);
        const clean = rig({ upstream: null });
        const done = await clean.save.save(WS);
        expect(done).toEqual({ ok: true, written: ['project.json'] });
        expect(clean.writes.map(([p]) => p)).toEqual([file('project.json')]);
    });

    it('refuses while a conflict is unresolved, and writes nothing', async () => {
        const { save, writes } = rig();
        const result = await save.save(WS, {});
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('project.json#sites/a');
        expect(writes).toEqual([]);
    });

    it("writes the merge the person chose: their value for the conflict, our new site, their new site", async () => {
        const { save, writes } = rig();
        const result = await save.save(WS, { 'project.json#sites/a': 'incoming' });
        expect(result).toEqual({ ok: true, written: ['project.json'] });
        const merged = JSON.parse(writes[0]![1]);
        expect(merged.sites).toEqual({ a: { name: 'a3' }, b: { name: 'b' }, c: { name: 'c' } });
    });

    it('fetches again at save, so a teammate push since the preview is seen', async () => {
        const { save, calls } = rig();
        await save.preview(WS);
        const before = calls.filter((c) => c === 'fetch').length;
        await save.save(WS, { 'project.json#sites/a': 'local' });
        expect(calls.filter((c) => c === 'fetch').length).toBe(before + 1);
    });

    it('a write that fails reports what was written and which file failed', async () => {
        const live = modelOf(LOCAL, [{ path: '.processes/q.json', value: { command: 'x', folder: 'repos/app' } }]);
        const { save, writes } = rig({ upstream: null, live, failWriteOf: '.processes/q.json' });
        const result = await save.save(WS);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.written).toEqual(['project.json']);
        expect(result.reason).toContain('.processes/q.json');
        expect(writes.map(([p]) => p)).toEqual([file('project.json')]);
    });

    it('a hibernated workspace is a ghost: not read, not fetched, nothing planned', async () => {
        const { save, calls } = rig({ mayRead: false });
        const preview = await save.preview(WS);
        expect(preview.plan.ok).toBe(false);
        expect(calls).toEqual([]);
    });
});
