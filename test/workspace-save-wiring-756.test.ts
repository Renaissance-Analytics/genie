import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capabilityOf, WORKSPACE_SCOPED_METHODS } from '../src/core/remote-protocol.js';
import { HOST_WORKSPACE_LIFECYCLE_METHODS } from '../src/main/host-alone-api.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { parseSaveChoices, workspaceSaveOps, type SaveFs, type SaveGit } from '../src/main/workspace-save-host.js';

/**
 * SAVE TO REPO, WIRED (Tynn #756 UI): the two bridge methods `workspaces.savePreview` (a read) and `workspaces.save` (a
 * write) from the dialog to the planner. Workspace-scoped, answered by genie-host while no window is connected, and only for
 * the host's OWNER (it writes the owner's repo and runs the owner's git). A workspace id the host does not know, a missing
 * project.json and one that is not JSON are each refused in words; the tynn-c5 entry in this envelope's own project.json is
 * refused through the very same path the dialog uses.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const C5 = {
    repo: 'tynn-c5-proof', runMode: 'host', kind: 'http', enabled: true, name: 'tynn-c5', genName: 'tynn-c5.gen',
    command: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/_Projects/tynn.ai/.ai/sandbox/genie-marketplace-c5/serve-proof.ps1', '-Port', '{port}'],
};

function rig(projectJson: string | null, options: { mayRead?: boolean } = {}) {
    const calls: string[] = [];
    const fs: SaveFs = {
        async readText(path) { calls.push(`read ${path}`); return path === '/w/acme/project.json' ? projectJson : null; },
        async writeTextAtomic(path) { calls.push(`write ${path}`); },
    };
    const git: SaveGit = {
        async fetch() { calls.push('fetch'); return { ok: true }; },
        async upstream() { return null; },
        async mergeBase() { return null; },
        async show() { return null; },
    };
    const ops = workspaceSaveOps({ fs, git, pathOf: (id) => (id === 'acme' ? '/w/acme' : null), ...(options.mayRead === undefined ? {} : { mayReadFolder: () => options.mayRead! }) });
    return { ops, calls };
}
const manifest = `${JSON.stringify({ name: 'Acme', repos: [{ name: 'app', path: 'repos/app' }] }, null, 2)}\n`;

describe('the protocol', () => {
    it('savePreview is a read and save is a write, both scoped to the workspace they name', () => {
        expect(capabilityOf('workspaces.savePreview')).toBe('read');
        expect(capabilityOf('workspaces.save')).toBe('write');
        expect(WORKSPACE_SCOPED_METHODS).toContain('workspaces.savePreview');
        expect(WORKSPACE_SCOPED_METHODS).toContain('workspaces.save');
    });

    it('genie-host answers both while no window is connected', () => {
        expect(HOST_WORKSPACE_LIFECYCLE_METHODS.has('workspaces.savePreview')).toBe(true);
        expect(HOST_WORKSPACE_LIFECYCLE_METHODS.has('workspaces.save')).toBe(true);
    });

    it('the host API hands the workspace id, and the choices, to the workspace ops', async () => {
        const calls: unknown[][] = [];
        const ops = {
            savePreview: async (id: string) => { calls.push(['preview', id]); return { plan: { ok: true } }; },
            save: async (id: string, choices: unknown) => { calls.push(['save', id, choices]); return { ok: true, written: [] }; },
        };
        const api = buildHostApi({ workspaceOps: ops } as unknown as HostApiDeps);
        expect(await api.invoke('workspaces.savePreview', ['acme'])).toEqual({ plan: { ok: true } });
        expect(await api.invoke('workspaces.save', ['acme', { 'project.json#sites/a1': 'incoming' }])).toEqual({ ok: true, written: [] });
        expect(calls).toEqual([['preview', 'acme'], ['save', 'acme', { 'project.json#sites/a1': 'incoming' }]]);
    });

    it('a host without them refuses in words rather than throwing', async () => {
        const api = buildHostApi({ workspaceOps: {} } as unknown as HostApiDeps);
        expect(await api.invoke('workspaces.savePreview', ['acme'])).toMatchObject({ plan: { ok: false } });
        expect(await api.invoke('workspaces.save', ['acme', {}])).toMatchObject({ ok: false, written: [] });
    });

    it('the window and genie-host build the ops, and the standalone host hands them to the lifecycle wiring', () => {
        for (const file of ['src/main/main.ts', 'src/main/genie-host.ts']) expect(src(file), file).toContain('workspaceSaveOps(');
        expect(src('src/main/host-alone-api.ts')).toContain('ports.workspaceSave');
    });

    it('the window reaches them through the local session and the remote bridge', () => {
        expect(src('src/renderer/remote-bridge.ts')).toContain("answer('workspaces.savePreview'");
        expect(src('src/renderer/remote-bridge.ts')).toContain("answer('workspaces.save'");
        expect(src('src/renderer/local-session.ts')).toContain('savePreview: (id) =>');
        expect(src('src/renderer/local-session.ts')).toContain('save: (id, choices) =>');
    });
});

describe('the ops the dialog calls', () => {
    it('a workspace the host does not know is refused in words, and nothing is read', async () => {
        const { ops, calls } = rig(manifest);
        const preview = await ops.savePreview('nowhere');
        expect(preview.plan).toMatchObject({ ok: false, reason: 'name a workspace' });
        expect(await ops.save('nowhere', {})).toEqual({ ok: false, reason: 'name a workspace', written: [] });
        expect(calls).toEqual([]);
    });

    it('reads project.json from the workspace folder and previews it: nothing to change shows as unchanged', async () => {
        const { ops } = rig(manifest);
        const preview = await ops.savePreview('acme');
        expect(preview.plan.ok).toBe(true);
        expect(preview.files).toEqual([{ path: 'project.json', status: 'unchanged' }]);
    });

    it('no project.json is refused in words', async () => {
        const preview = await rig(null).ops.savePreview('acme');
        expect(preview.plan).toMatchObject({ ok: false, reason: 'this workspace has no project.json' });
    });

    it('a project.json that is not JSON is refused in words and never rewritten', async () => {
        const { ops, calls } = rig('{ not json');
        const preview = await ops.savePreview('acme');
        expect(preview.plan).toMatchObject({ ok: false });
        if (!preview.plan.ok) expect(preview.plan.reason).toContain('not valid JSON');
        expect((await ops.save('acme', {})).ok).toBe(false);
        expect(calls.some((c) => c.startsWith('write'))).toBe(false);
    });

    it("this envelope's own tynn-c5 site is refused through the dialog's path, naming the field", async () => {
        const dirty = `${JSON.stringify({ name: 'Acme', sites: { '998de12a1f1278a9': C5 } }, null, 2)}\n`;
        const { ops, calls } = rig(dirty);
        const preview = await ops.savePreview('acme');
        expect(preview.plan.ok).toBe(false);
        if (!preview.plan.ok) expect(preview.plan.violations.map((v) => v.path)).toContain('project.json.sites.998de12a1f1278a9.command[5]');
        const saved = await ops.save('acme', {});
        expect(saved.ok).toBe(false);
        expect(calls.some((c) => c.startsWith('write'))).toBe(false);
    });

    it('a hibernated workspace is a ghost: not read', async () => {
        const { ops, calls } = rig(manifest, { mayRead: false });
        expect((await ops.savePreview('acme')).plan.ok).toBe(false);
        expect(calls).toEqual([]);
    });
});

describe('the choices the dialog sends', () => {
    it('only "local" and "incoming" for a string id are kept; anything else is dropped, never guessed', () => {
        expect(parseSaveChoices({ a: 'local', b: 'incoming', c: 'maybe', d: 1, e: null, f: { x: 1 } })).toEqual({ a: 'local', b: 'incoming' });
    });

    it('CONTROL: no choices, or something that is not an object, is no choices', () => {
        for (const raw of [undefined, null, 'local', 7, ['local']]) expect(parseSaveChoices(raw)).toEqual({});
    });
});
